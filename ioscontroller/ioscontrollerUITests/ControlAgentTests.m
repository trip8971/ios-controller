//
//  ControlAgentTests.m
//  ioscontrollerUITests
//
//  XCUITest 控制代理 — 在设备上启动 HTTP 服务器接收控制指令
//  触摸操作必须在主线程执行
//

#import <XCTest/XCTest.h>
#import <UIKit/UIPasteboard.h>
#import <sys/socket.h>
#import <netinet/in.h>
#import <signal.h>

// WDA 风格私有 API 前向声明 — 通过 XCPointerEventPath + XCSynthesizedEventRecord
// 直接向系统注入键盘事件，绕开 XCUIElement 的 hasKeyboardFocus 检查。
// 真机、模拟器、原生输入框、WebView、浏览器均可用。
@interface XCPointerEventPath : NSObject
- (instancetype)initForTextInput;
- (void)typeText:(NSString *)text atOffset:(double)offset typingSpeed:(NSUInteger)speed shouldRedact:(BOOL)redact;
- (void)typeKey:(NSString *)key modifiers:(unsigned long long)modifiers atOffset:(double)offset;
@end

@interface XCSynthesizedEventRecord : NSObject
- (instancetype)initWithName:(NSString *)name;
- (void)addPointerEventPath:(XCPointerEventPath *)path;
- (BOOL)synthesizeWithError:(NSError **)error;
@end

static const int kPort = 8200;
static const NSTimeInterval kTimeout = 86400.0;

@interface ControlAgentTests : XCTestCase
@property (nonatomic, strong) XCUIApplication *app;
@property (nonatomic, assign) int sock;
@property (nonatomic, assign) BOOL running;
@end
    
@implementation ControlAgentTests

- (void)setUp {
    [super setUp];
    self.continueAfterFailure = YES;
    self.running = YES;
    self.sock = -1;

    // 不启动被测应用，直接用 Springboard 作为触摸目标
    // 这样触摸坐标是相对于整个屏幕的
    self.app = [[XCUIApplication alloc] initWithBundleIdentifier:@"com.apple.springboard"];
    [self.app activate];
    NSLog(@"[Agent] Using Springboard, frame: %@", NSStringFromCGRect(self.app.frame));
}

- (void)tearDown {
    self.running = NO;
    if (self.sock >= 0) { close(self.sock); self.sock = -1; }
    [super tearDown];
}

- (void)testControlAgent {
    // 忽略 SIGPIPE，防止客户端提前断开时 send() 杀死测试进程（exit code 13）
    signal(SIGPIPE, SIG_IGN);

    self.sock = socket(AF_INET, SOCK_STREAM, 0);
    if (self.sock < 0) { NSLog(@"[Agent] socket() failed: %s", strerror(errno)); return; }

    int yes = 1;
    setsockopt(self.sock, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes));

    struct sockaddr_in addr = {0};
    addr.sin_family = AF_INET;
    addr.sin_port = htons(kPort);
    addr.sin_addr.s_addr = INADDR_ANY;

    if (bind(self.sock, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        NSLog(@"[Agent] bind failed: %s", strerror(errno));
        close(self.sock); return;
    }
    if (listen(self.sock, 5) < 0) {
        NSLog(@"[Agent] listen failed: %s", strerror(errno));
        close(self.sock); return;
    }

    NSLog(@"[Agent] Listening on port %d", kPort);
    NSLog(@"[Agent] Run on Mac: iproxy %d %d", kPort, kPort);

    XCTestExpectation *exp = [self expectationWithDescription:@"agent"];

    dispatch_async(dispatch_get_global_queue(0, 0), ^{
        while (self.running) {
            struct sockaddr_in ca;
            socklen_t cl = sizeof(ca);
            int cs = accept(self.sock, (struct sockaddr *)&ca, &cl);
            if (cs < 0) continue;

            // 防止写入已关闭的连接时触发 SIGPIPE
            int on = 1;
            setsockopt(cs, SOL_SOCKET, SO_NOSIGPIPE, &on, sizeof(on));

            NSLog(@"[Agent] Incoming connection");

            // 读取 HTTP 请求
            char buf[8192];
            ssize_t n = recv(cs, buf, sizeof(buf) - 1, 0);
            if (n <= 0) { close(cs); continue; }
            buf[n] = '\0';

            NSString *req = [NSString stringWithUTF8String:buf];
            NSString *firstLine = [req componentsSeparatedByString:@"\r\n"].firstObject;
            NSArray *parts = [firstLine componentsSeparatedByString:@" "];
            NSString *path = parts.count > 1 ? parts[1] : @"";

            NSString *body = nil;
            NSRange r = [req rangeOfString:@"\r\n\r\n"];
            if (r.location != NSNotFound) body = [req substringFromIndex:r.location + 4];

            NSLog(@"[Agent] %@ body=%lu bytes", firstLine, (unsigned long)(body ? body.length : 0));

            // /status 不需要主线程
            if ([path isEqualToString:@"/status"]) {
                [self respond:cs code:200 json:@"{\"status\":\"ready\"}"];
                close(cs);
                continue;
            }

            // 触摸操作必须在主线程执行
            dispatch_semaphore_t sem = dispatch_semaphore_create(0);
            __block NSString *result = @"{\"ok\":true}";
            __block int resultCode = 200;

            dispatch_async(dispatch_get_main_queue(), ^{
                @try {
                    if ([path isEqualToString:@"/tap"]) {
                        [self doTap:body];
                    } else if ([path isEqualToString:@"/swipe"]) {
                        [self doSwipe:body];
                    } else if ([path isEqualToString:@"/pressButton"]) {
                        [self doButton:body];
                    } else if ([path isEqualToString:@"/input"]) {
                        NSString *inputResult = [self doInput:body];
                        if (inputResult) {
                            resultCode = 500;
                            result = [NSString stringWithFormat:@"{\"ok\":false,\"error\":\"%@\"}", inputResult];
                        }
                    } else if ([path isEqualToString:@"/screenshot"]) {
                        // 截图返回 PNG 二进制
                        resultCode = -1; // 特殊标记，用二进制响应
                    } else {
                        resultCode = 404;
                        result = @"{\"error\":\"not found\"}";
                    }
                } @catch (NSException *e) {
                    NSLog(@"[Agent] Exception: %@", e.reason);
                    resultCode = 500;
                    result = [NSString stringWithFormat:@"{\"error\":\"%@\"}", e.reason];
                }
                dispatch_semaphore_signal(sem);
            });

            // 等待主线程执行完成（最多 10 秒）
            dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_SEC));

            if (resultCode == -1) {
                // 截图：在主线程完成后取截图并发送二进制
                [self doScreenshot:cs];
            } else {
                [self respond:cs code:resultCode json:result];
            }
            close(cs);
        }
        [exp fulfill];
    });

    [self waitForExpectations:@[exp] timeout:kTimeout];
}

#pragma mark - Touch (must be called on main thread)

- (void)doTap:(NSString *)body {
    NSDictionary *d = [self json:body];
    if (!d) return;

    CGFloat x = [d[@"x"] doubleValue];
    CGFloat y = [d[@"y"] doubleValue];
    CGRect b = self.app.frame;

    // If normalized (0-1), convert to screen points
    if ([d[@"normalized"] boolValue] || (x <= 1.0 && y <= 1.0 && x >= 0 && y >= 0)) {
        x = x * b.size.width;
        y = y * b.size.height;
    }

    x = MIN(MAX(x, 0), b.size.width);
    y = MIN(MAX(y, 0), b.size.height);

    NSLog(@"[Agent] Tap (%.1f, %.1f) screen=%.0fx%.0f", x, y, b.size.width, b.size.height);

    XCUICoordinate *o = [self.app coordinateWithNormalizedOffset:CGVectorMake(0, 0)];
    [[o coordinateWithOffset:CGVectorMake(x, y)] tap];

    NSLog(@"[Agent] Tap done");
}

- (void)doSwipe:(NSString *)body {
    NSDictionary *d = [self json:body];
    if (!d) return;

    CGFloat sx = [d[@"startX"] doubleValue], sy = [d[@"startY"] doubleValue];
    CGFloat ex = [d[@"endX"] doubleValue], ey = [d[@"endY"] doubleValue];
    CGRect b = self.app.frame;

    // If normalized (0-1), convert to screen points
    if ([d[@"normalized"] boolValue] || (sx <= 1.0 && sy <= 1.0 && sx >= 0 && sy >= 0)) {
        sx *= b.size.width;  sy *= b.size.height;
        ex *= b.size.width;  ey *= b.size.height;
    }

    sx = MIN(MAX(sx, 0), b.size.width);  sy = MIN(MAX(sy, 0), b.size.height);
    ex = MIN(MAX(ex, 0), b.size.width);  ey = MIN(MAX(ey, 0), b.size.height);

    NSLog(@"[Agent] Swipe (%.1f,%.1f) -> (%.1f,%.1f) screen=%.0fx%.0f", sx, sy, ex, ey, b.size.width, b.size.height);

    XCUICoordinate *o = [self.app coordinateWithNormalizedOffset:CGVectorMake(0, 0)];
    XCUICoordinate *s = [o coordinateWithOffset:CGVectorMake(sx, sy)];
    XCUICoordinate *e = [o coordinateWithOffset:CGVectorMake(ex, ey)];
    [s pressForDuration:0.01 thenDragToCoordinate:e withVelocity:2000 thenHoldForDuration:0.0];

    NSLog(@"[Agent] Swipe done");
}

- (void)doButton:(NSString *)body {
    NSDictionary *d = [self json:body];
    if (!d) return;

    NSString *name = d[@"name"];
    NSLog(@"[Agent] Button: %@", name);

    if ([name isEqualToString:@"home"]) {
        // 先尝试 pressButton，如果不生效则用上滑手势模拟
        [[XCUIDevice sharedDevice] pressButton:XCUIDeviceButtonHome];
        NSLog(@"[Agent] Home pressed");
    }
#if !TARGET_OS_SIMULATOR
    else if ([name isEqualToString:@"volumeUp"]) {
        [[XCUIDevice sharedDevice] pressButton:XCUIDeviceButtonVolumeUp];
    } else if ([name isEqualToString:@"volumeDown"]) {
        [[XCUIDevice sharedDevice] pressButton:XCUIDeviceButtonVolumeDown];
    }
#endif
    NSLog(@"[Agent] Button done");
}

- (NSString *)doInput:(NSString *)body {
    NSDictionary *d = [self json:body];
    if (!d) return @"invalid JSON body";

    NSString *text = d[@"text"];
    if (!text || text.length == 0) {
        NSLog(@"[Agent] Input: empty text, skipping");
        return @"empty text";
    }

    BOOL clearFirst = [d[@"clearText"] boolValue];
    NSLog(@"[Agent] Input: \"%@\" clearText=%d", text, clearFirst);

    if (clearFirst) {
        [self clearFocusedText];
    }

    // 使用 WDA 风格私有 API 注入键盘事件，绕开 XCUIElement 的 hasKeyboardFocus 检查
    // 原生输入框、WebView、浏览器均可用，真机模拟器通用
    NSError *err = nil;
    if (![self synthesizeText:text error:&err]) {
        NSLog(@"[Agent] Input synthesize failed: %@", err.localizedDescription);
        return err.localizedDescription ?: @"input synthesize failed";
    }
    NSLog(@"[Agent] Input done");
    return nil;
}

/// 通过私有 API 直接向系统注入键盘事件（WDA 同款方案）
- (BOOL)synthesizeText:(NSString *)text error:(NSError **)error {
    XCSynthesizedEventRecord *record = [[XCSynthesizedEventRecord alloc] initWithName:@"Type text"];
    XCPointerEventPath *path = [[XCPointerEventPath alloc] initForTextInput];
    [path typeText:text atOffset:0.0 typingSpeed:60 shouldRedact:NO];
    [record addPointerEventPath:path];
    return [record synthesizeWithError:error];
}

/// 清空当前焦点输入框的文本
/// 原生输入框：读 value 逐字退格；WebView：全选+退格
- (void)clearFocusedText {
    // 先尝试原生路径：通过 hasKeyboardFocus 找到元素并读取 value
    XCUIApplication *activeApp = [self activeApplication];
    if (activeApp) {
        XCUIElement *focused = [[activeApp descendantsMatchingType:XCUIElementTypeAny]
                                matchingPredicate:[NSPredicate predicateWithFormat:@"hasKeyboardFocus == YES"]].firstMatch;
        if (focused && focused.exists) {
            NSString *currentValue = focused.value;
            if (currentValue && currentValue.length > 0) {
                NSLog(@"[Agent] clearText: clearing %lu chars", (unsigned long)currentValue.length);
                NSMutableString *deleteString = [NSMutableString string];
                for (NSUInteger i = 0; i < currentValue.length; i++) {
                    [deleteString appendFormat:@"%C", (unichar)0x7F];
                }
                [self synthesizeText:deleteString error:nil];
                NSLog(@"[Agent] clearText: done");
                return;
            }
            NSLog(@"[Agent] clearText: field already empty");
            return;
        }
    }

    // WebView 路径：无法读 value，用 Cmd+A 全选 + 退格
    NSLog(@"[Agent] clearText: no focused element, using select-all + delete");
    // Cmd+A 全选（通过 typeKey:modifiers: 发送带修饰键的按键）
    XCSynthesizedEventRecord *selectRecord = [[XCSynthesizedEventRecord alloc] initWithName:@"Select All"];
    XCPointerEventPath *selectPath = [[XCPointerEventPath alloc] initForTextInput];
    [selectPath typeKey:@"a" modifiers:(1 << 20) atOffset:0.0]; // 1<<20 = Command key
    [selectRecord addPointerEventPath:selectPath];
    [selectRecord synthesizeWithError:nil];

    // 退格删除选中内容
    NSString *backspace = [NSString stringWithFormat:@"%C", (unichar)0x7F];
    [self synthesizeText:backspace error:nil];
    NSLog(@"[Agent] clearText: done");
}

/// WDA 方式获取前台活跃 app
/// 核心路径: XCUIDevice.sharedDevice.accessibilityInterface → activeApplications → monitoredApplicationWithProcessIdentifier:
- (XCUIApplication *)activeApplication {
    // 获取 XCAXClient_iOS 实例
    SEL aiSel = NSSelectorFromString(@"accessibilityInterface");
    if (![[XCUIDevice sharedDevice] respondsToSelector:aiSel]) {
        NSLog(@"[Agent] accessibilityInterface not available");
        return nil;
    }

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Warc-performSelector-leaks"
    id axClient = [[XCUIDevice sharedDevice] performSelector:aiSel];
#pragma clang diagnostic pop

    if (!axClient) {
        NSLog(@"[Agent] accessibilityInterface returned nil");
        return nil;
    }

    // 获取活跃 app 列表
    SEL activeAppsSel = NSSelectorFromString(@"activeApplications");
    if (![axClient respondsToSelector:activeAppsSel]) {
        NSLog(@"[Agent] activeApplications not available on axClient");
        return nil;
    }

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Warc-performSelector-leaks"
    NSArray *activeApps = [axClient performSelector:activeAppsSel];
#pragma clang diagnostic pop

    if (!activeApps || activeApps.count == 0) {
        NSLog(@"[Agent] No active applications");
        return nil;
    }

    NSLog(@"[Agent] Found %lu active app element(s)", (unsigned long)activeApps.count);

    // 获取 applicationProcessTracker
    SEL trackerSel = NSSelectorFromString(@"applicationProcessTracker");
    id tracker = nil;
    if ([axClient respondsToSelector:trackerSel]) {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Warc-performSelector-leaks"
        tracker = [axClient performSelector:trackerSel];
#pragma clang diagnostic pop
    }

    // 遍历活跃 app，通过 PID 获取 XCUIApplication 实例
    for (id appElement in activeApps) {
        // 获取 processIdentifier
        SEL pidSel = NSSelectorFromString(@"processIdentifier");
        if (![appElement respondsToSelector:pidSel]) continue;

        NSMethodSignature *pidSig = [appElement methodSignatureForSelector:pidSel];
        NSInvocation *pidInv = [NSInvocation invocationWithMethodSignature:pidSig];
        [pidInv setSelector:pidSel];
        [pidInv invokeWithTarget:appElement];
        int pid = 0;
        [pidInv getReturnValue:&pid];

        if (pid <= 0) continue;
        NSLog(@"[Agent] Active app element pid=%d", pid);

        // 通过 tracker 获取 monitored XCUIApplication
        if (tracker) {
            SEL monSel = NSSelectorFromString(@"monitoredApplicationWithProcessIdentifier:");
            if ([tracker respondsToSelector:monSel]) {
                NSMethodSignature *monSig = [tracker methodSignatureForSelector:monSel];
                NSInvocation *monInv = [NSInvocation invocationWithMethodSignature:monSig];
                [monInv setSelector:monSel];
                [monInv setArgument:&pid atIndex:2];
                [monInv invokeWithTarget:tracker];
                XCUIApplication * __unsafe_unretained app = nil;
                [monInv getReturnValue:&app];
                if (app) {
                    return app;
                }
            }
        }
    }

    NSLog(@"[Agent] Could not resolve any active app via tracker");
    return nil;
}

#pragma mark - Screenshot

- (void)doScreenshot:(int)cs {
    NSLog(@"[Agent] Taking screenshot...");

    // XCUIScreen.main 截图（必须在主线程调用，但我们已经在 semaphore 之后）
    // 实际上 screenshot 需要在主线程，让我们用 dispatch_sync
    __block NSData *pngData = nil;

    dispatch_sync(dispatch_get_main_queue(), ^{
        XCUIScreenshot *screenshot = [XCUIScreen.mainScreen screenshot];
        pngData = UIImagePNGRepresentation(screenshot.image);
    });

    if (!pngData) {
        [self respond:cs code:500 json:@"{\"error\":\"screenshot failed\"}"];
        return;
    }

    NSLog(@"[Agent] Screenshot: %lu bytes", (unsigned long)pngData.length);

    NSString *header = [NSString stringWithFormat:
        @"HTTP/1.1 200 OK\r\n"
        @"Content-Type: image/png\r\n"
        @"Content-Length: %lu\r\n"
        @"Access-Control-Allow-Origin: *\r\n"
        @"Connection: close\r\n"
        @"\r\n",
        (unsigned long)pngData.length];

    const char *headerBytes = [header UTF8String];
    send(cs, headerBytes, strlen(headerBytes), 0);
    send(cs, pngData.bytes, pngData.length, 0);
}

#pragma mark - Helpers

- (NSDictionary *)json:(NSString *)s {
    if (!s || s.length == 0) return nil;
    NSData *d = [s dataUsingEncoding:NSUTF8StringEncoding];
    if (!d) return nil;
    id obj = [NSJSONSerialization JSONObjectWithData:d options:0 error:nil];
    return [obj isKindOfClass:[NSDictionary class]] ? obj : nil;
}

- (void)respond:(int)cs code:(int)code json:(NSString *)body {
    // body.length 是字符数，UTF-8 中文字符占 3 字节，必须用字节数作为 Content-Length
    NSData *bodyData = [body dataUsingEncoding:NSUTF8StringEncoding];
    NSString *header = [NSString stringWithFormat:
        @"HTTP/1.1 %d OK\r\n"
        @"Content-Type: application/json; charset=utf-8\r\n"
        @"Content-Length: %lu\r\n"
        @"Access-Control-Allow-Origin: *\r\n"
        @"Connection: close\r\n"
        @"\r\n",
        code, (unsigned long)bodyData.length];
    const char *headerBytes = [header UTF8String];
    send(cs, headerBytes, strlen(headerBytes), 0);
    send(cs, bodyData.bytes, bodyData.length, 0);
}

@end
