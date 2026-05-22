//
//  SampleHandler.m
//  BroadcastExtension
//
//  直接在 Extension 中通过 WebSocket 发送 fMP4 视频流
//  不再依赖主应用中转，录制期间无论 app 前后台都能持续传输
//

#import "SampleHandler.h"
#import "FMP4Muxer.h"

/// App Group 标识符（用于读取服务器地址配置）
static NSString * const kAppGroupIdentifier = @"group.com.yourappleid.ioscontroller";

static const int kTargetFPS = 60;
static const int kTargetBitrate = 8000000;

@interface SampleHandler ()

@property (nonatomic, strong, nullable) H264Encoder *encoder;
@property (nonatomic, strong, nullable) FMP4Muxer *muxer;
@property (nonatomic, strong, nullable) NSURLSession *urlSession;
@property (nonatomic, strong, nullable) NSURLSessionWebSocketTask *wsTask;
@property (nonatomic, assign) BOOL wsConnected;
@property (nonatomic, assign) BOOL encoderInitialized;
@property (nonatomic, assign) BOOL initSegmentSent;
@property (nonatomic, strong, nullable) NSData *cachedSPS;
@property (nonatomic, strong, nullable) NSData *cachedPPS;
@property (nonatomic, assign) int videoWidth;
@property (nonatomic, assign) int videoHeight;
@property (nonatomic, assign) uint64_t frameTimestamp;
@property (nonatomic, assign) uint64_t frameDuration;
@property (nonatomic, strong) dispatch_queue_t sendQueue;
@property (nonatomic, assign) BOOL forceKeyframe;

@end

@implementation SampleHandler

#pragma mark - Broadcast Lifecycle

- (void)broadcastStartedWithSetupInfo:(NSDictionary<NSString *, NSObject *> *)setupInfo {
    NSLog(@"[Extension] Broadcast started");

    self.encoderInitialized = NO;
    self.initSegmentSent = NO;
    self.wsConnected = NO;
    self.frameTimestamp = 0;
    self.frameDuration = 90000 / kTargetFPS;
    self.sendQueue = dispatch_queue_create("com.yourappleid.ext.sendQueue", DISPATCH_QUEUE_SERIAL);

    // 从 App Group UserDefaults 读取服务器地址
    NSUserDefaults *shared = [[NSUserDefaults alloc] initWithSuiteName:kAppGroupIdentifier];
    NSString *serverURL = [shared stringForKey:@"serverURL"];
    if (!serverURL || serverURL.length == 0) {
        serverURL = @"ws://192.168.1.100:8080";
    }
    NSLog(@"[Extension] Server URL: %@", serverURL);

    // 建立 WebSocket 连接
    NSURLSessionConfiguration *config = [NSURLSessionConfiguration defaultSessionConfiguration];
    self.urlSession = [NSURLSession sessionWithConfiguration:config delegate:self delegateQueue:nil];
    self.wsTask = [self.urlSession webSocketTaskWithURL:[NSURL URLWithString:serverURL]];
    [self.wsTask resume];
}

- (void)broadcastPaused {
    NSLog(@"[Extension] Broadcast paused");
}

- (void)broadcastResumed {
    NSLog(@"[Extension] Broadcast resumed");
}

- (void)broadcastFinished {
    NSLog(@"[Extension] Broadcast finished");
    if (self.encoder) { [self.encoder stopEncoding]; self.encoder = nil; }
    if (self.wsTask) { [self.wsTask cancelWithCloseCode:NSURLSessionWebSocketCloseCodeNormalClosure reason:nil]; self.wsTask = nil; }
    if (self.urlSession) { [self.urlSession invalidateAndCancel]; self.urlSession = nil; }
}

#pragma mark - WebSocket Delegate

- (void)URLSession:(NSURLSession *)session webSocketTask:(NSURLSessionWebSocketTask *)webSocketTask didOpenWithProtocol:(NSString *)protocol {
    NSLog(@"[Extension] WebSocket connected");
    self.wsConnected = YES;

    // 发送 device 注册消息
    NSDictionary *reg = @{ @"type": @"register", @"role": @"device" };
    NSData *json = [NSJSONSerialization dataWithJSONObject:reg options:0 error:nil];
    NSString *str = [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding];
    [self.wsTask sendMessage:[[NSURLSessionWebSocketMessage alloc] initWithString:str]
           completionHandler:^(NSError *err) {
        if (err) NSLog(@"[Extension] Register send error: %@", err);
        else NSLog(@"[Extension] Registered as device");
    }];

    // 开始接收消息
    [self receiveMessages];

    // 如果已有 SPS/PPS，立即发送 init segment
    if (self.cachedSPS && self.cachedPPS && !self.initSegmentSent) {
        [self sendInitSegment];
    }
}

/// 持续接收 WebSocket 消息
- (void)receiveMessages {
    if (!self.wsTask) return;
    __weak typeof(self) w = self;
    [self.wsTask receiveMessageWithCompletionHandler:^(NSURLSessionWebSocketMessage *msg, NSError *err) {
        if (err) { NSLog(@"[Extension] Receive error: %@", err.localizedDescription); return; }
        if (msg.type == NSURLSessionWebSocketMessageTypeString) {
            [w handleServerMessage:msg.string];
        }
        [w receiveMessages];
    }];
}

/// 处理服务器消息
- (void)handleServerMessage:(NSString *)jsonStr {
    NSData *data = [jsonStr dataUsingEncoding:NSUTF8StringEncoding];
    NSDictionary *msg = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
    if (![msg isKindOfClass:[NSDictionary class]]) return;

    NSString *type = msg[@"type"];
    if ([type isEqualToString:@"session_ready"]) {
        NSLog(@"[Extension] Viewer joined!");
    } else if ([type isEqualToString:@"request_keyframe"]) {
        NSLog(@"[Extension] Keyframe requested, forcing next frame as keyframe");
        self.forceKeyframe = YES;
    }
}

- (void)URLSession:(NSURLSession *)session webSocketTask:(NSURLSessionWebSocketTask *)webSocketTask didCloseWithCode:(NSURLSessionWebSocketCloseCode)closeCode reason:(NSData *)reason {
    NSLog(@"[Extension] WebSocket closed: %ld", (long)closeCode);
    self.wsConnected = NO;
}

- (void)URLSession:(NSURLSession *)session task:(NSURLSessionTask *)task didCompleteWithError:(NSError *)error {
    if (error) {
        NSLog(@"[Extension] WebSocket error: %@", error.localizedDescription);
        self.wsConnected = NO;
    }
}

#pragma mark - Sample Buffer

- (void)processSampleBuffer:(CMSampleBufferRef)sampleBuffer withType:(RPSampleBufferType)sampleBufferType {
    if (sampleBufferType != RPSampleBufferTypeVideo) return;

    CVPixelBufferRef pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer);
    if (!pixelBuffer) return;

    if (!self.encoderInitialized) {
        self.videoWidth = (int)CVPixelBufferGetWidth(pixelBuffer);
        self.videoHeight = (int)CVPixelBufferGetHeight(pixelBuffer);
        NSLog(@"[Extension] Video resolution: %dx%d", self.videoWidth, self.videoHeight);

        self.encoder = [[H264Encoder alloc] initWithWidth:self.videoWidth
                                                   height:self.videoHeight
                                                      fps:kTargetFPS
                                                  bitrate:kTargetBitrate];
        self.encoder.delegate = self;
        self.encoderInitialized = YES;
    }

    CMTime pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer);

    // 如果需要强制关键帧
    if (self.forceKeyframe) {
        self.forceKeyframe = NO;
        [self.encoder forceKeyframe];
    }

    [self.encoder encodePixelBuffer:pixelBuffer presentationTime:pts];
}

#pragma mark - H264EncoderDelegate

- (void)encoder:(H264Encoder *)encoder didOutputSPS:(NSData *)sps PPS:(NSData *)pps {
    NSLog(@"[Extension] SPS (%lu) + PPS (%lu)", (unsigned long)sps.length, (unsigned long)pps.length);
    self.cachedSPS = sps;
    self.cachedPPS = pps;

    // 每次收到 SPS/PPS 都重新发送 init segment（支持 device 重连场景）
    if (self.wsConnected) {
        [self sendInitSegment];
    }

    if (self.wsConnected) {
        [self sendInitSegment];
    }
}

- (void)encoder:(H264Encoder *)encoder didOutputNALUnit:(NSData *)nalUnit isKeyFrame:(BOOL)isKeyFrame {
    if (!self.muxer || !self.wsConnected) return;

    dispatch_async(self.sendQueue, ^{
        NSData *segment = [self.muxer muxNALUnit:nalUnit
                                      isKeyFrame:isKeyFrame
                                       timestamp:self.frameTimestamp
                                        duration:self.frameDuration];
        self.frameTimestamp += self.frameDuration;

        if (segment) {
            [self sendBinary:segment];
        }
    });
}

#pragma mark - FMP4 Init Segment

- (void)sendInitSegment {
    if (!self.cachedSPS || !self.cachedPPS) return;

    self.muxer = [[FMP4Muxer alloc] initWithSPS:self.cachedSPS
                                             PPS:self.cachedPPS
                                           width:self.videoWidth
                                          height:self.videoHeight];

    NSData *initSeg = [self.muxer generateInitSegment];
    if (initSeg) {
        NSLog(@"[Extension] Sending init segment: %lu bytes", (unsigned long)initSeg.length);
        [self sendBinary:initSeg];
        self.initSegmentSent = YES;
    }
}

#pragma mark - Send Binary

- (void)sendBinary:(NSData *)data {
    if (!self.wsTask || !self.wsConnected) return;

    NSURLSessionWebSocketMessage *msg = [[NSURLSessionWebSocketMessage alloc] initWithData:data];
    [self.wsTask sendMessage:msg completionHandler:^(NSError *err) {
        if (err) {
            NSLog(@"[Extension] Send error: %@", err.localizedDescription);
        }
    }];
}

@end
