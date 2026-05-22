//
//  ViewController.m
//  ioscontroller
//
//  主视图控制器 — 提供服务器地址输入和录制按钮
//  视频采集和 WebSocket 发送由 BroadcastExtension 独立完成
//

#import "ViewController.h"
#import <ReplayKit/ReplayKit.h>

/// App Group 标识符
static NSString * const kAppGroupIdentifier = @"group.com.yourappleid.ioscontroller";

@interface ViewController ()

@property (nonatomic, strong) UILabel *statusLabel;
@property (nonatomic, strong) UITextField *serverURLField;

@end

@implementation ViewController

- (void)viewDidLoad {
    [super viewDidLoad];
    self.view.backgroundColor = [UIColor systemBackgroundColor];

    // 从 App Group 读取上次保存的服务器地址
    NSUserDefaults *shared = [[NSUserDefaults alloc] initWithSuiteName:kAppGroupIdentifier];
    NSString *savedURL = [shared stringForKey:@"serverURL"];

    [self setupUIWithSavedURL:savedURL];
}

#pragma mark - UI

- (void)setupUIWithSavedURL:(NSString *)savedURL {
    // 标题
    UILabel *titleLabel = [[UILabel alloc] init];
    titleLabel.translatesAutoresizingMaskIntoConstraints = NO;
    titleLabel.text = @"iOS Remote Control";
    titleLabel.textAlignment = NSTextAlignmentCenter;
    titleLabel.font = [UIFont boldSystemFontOfSize:20];
    [self.view addSubview:titleLabel];

    // 服务器地址输入框
    self.serverURLField = [[UITextField alloc] init];
    self.serverURLField.translatesAutoresizingMaskIntoConstraints = NO;
    self.serverURLField.text = savedURL ?: @"ws://192.168.1.100:8080";
    self.serverURLField.placeholder = @"ws://IP:8080";
    self.serverURLField.borderStyle = UITextBorderStyleRoundedRect;
    self.serverURLField.font = [UIFont monospacedSystemFontOfSize:14 weight:UIFontWeightRegular];
    self.serverURLField.textAlignment = NSTextAlignmentCenter;
    self.serverURLField.autocorrectionType = UITextAutocorrectionTypeNo;
    self.serverURLField.autocapitalizationType = UITextAutocapitalizationTypeNone;
    self.serverURLField.keyboardType = UIKeyboardTypeURL;
    self.serverURLField.returnKeyType = UIReturnKeyDone;
    self.serverURLField.delegate = self;
    [self.view addSubview:self.serverURLField];

    // 保存按钮
    UIButton *saveBtn = [UIButton buttonWithType:UIButtonTypeSystem];
    saveBtn.translatesAutoresizingMaskIntoConstraints = NO;
    [saveBtn setTitle:@"保存" forState:UIControlStateNormal];
    saveBtn.titleLabel.font = [UIFont boldSystemFontOfSize:14];
    [saveBtn addTarget:self action:@selector(onSaveTapped) forControlEvents:UIControlEventTouchUpInside];
    [self.view addSubview:saveBtn];

    // 状态
    self.statusLabel = [[UILabel alloc] init];
    self.statusLabel.translatesAutoresizingMaskIntoConstraints = NO;
    self.statusLabel.text = @"输入服务器地址后点保存，再点录制按钮";
    self.statusLabel.textAlignment = NSTextAlignmentCenter;
    self.statusLabel.textColor = [UIColor secondaryLabelColor];
    self.statusLabel.font = [UIFont systemFontOfSize:13];
    self.statusLabel.numberOfLines = 0;
    [self.view addSubview:self.statusLabel];

    // 录制按钮
    RPSystemBroadcastPickerView *picker = [[RPSystemBroadcastPickerView alloc] initWithFrame:CGRectMake(0, 0, 80, 80)];
    picker.translatesAutoresizingMaskIntoConstraints = NO;
    picker.preferredExtension = @"com.yourappleid.ioscontroller.BroadcastExtension";
    picker.showsMicrophoneButton = NO;
    picker.tintColor = [UIColor whiteColor];
    picker.backgroundColor = [UIColor systemRedColor];
    picker.layer.cornerRadius = 40;
    picker.clipsToBounds = YES;
    [self.view addSubview:picker];

    // 提示
    UILabel *hintLabel = [[UILabel alloc] init];
    hintLabel.translatesAutoresizingMaskIntoConstraints = NO;
    hintLabel.text = @"点击上方按钮开始屏幕录制\nExtension 会直接连接服务器发送视频";
    hintLabel.textAlignment = NSTextAlignmentCenter;
    hintLabel.textColor = [UIColor tertiaryLabelColor];
    hintLabel.font = [UIFont systemFontOfSize:12];
    hintLabel.numberOfLines = 0;
    [self.view addSubview:hintLabel];

    [NSLayoutConstraint activateConstraints:@[
        [titleLabel.centerXAnchor constraintEqualToAnchor:self.view.centerXAnchor],
        [titleLabel.topAnchor constraintEqualToAnchor:self.view.safeAreaLayoutGuide.topAnchor constant:30],

        [self.serverURLField.topAnchor constraintEqualToAnchor:titleLabel.bottomAnchor constant:20],
        [self.serverURLField.leadingAnchor constraintEqualToAnchor:self.view.leadingAnchor constant:20],
        [self.serverURLField.trailingAnchor constraintEqualToAnchor:saveBtn.leadingAnchor constant:-8],
        [self.serverURLField.heightAnchor constraintEqualToConstant:36],

        [saveBtn.trailingAnchor constraintEqualToAnchor:self.view.trailingAnchor constant:-20],
        [saveBtn.centerYAnchor constraintEqualToAnchor:self.serverURLField.centerYAnchor],
        [saveBtn.widthAnchor constraintEqualToConstant:50],

        [self.statusLabel.centerXAnchor constraintEqualToAnchor:self.view.centerXAnchor],
        [self.statusLabel.topAnchor constraintEqualToAnchor:self.serverURLField.bottomAnchor constant:10],
        [self.statusLabel.leadingAnchor constraintEqualToAnchor:self.view.leadingAnchor constant:20],
        [self.statusLabel.trailingAnchor constraintEqualToAnchor:self.view.trailingAnchor constant:-20],

        [picker.centerXAnchor constraintEqualToAnchor:self.view.centerXAnchor],
        [picker.centerYAnchor constraintEqualToAnchor:self.view.centerYAnchor],
        [picker.widthAnchor constraintEqualToConstant:80],
        [picker.heightAnchor constraintEqualToConstant:80],

        [hintLabel.centerXAnchor constraintEqualToAnchor:self.view.centerXAnchor],
        [hintLabel.topAnchor constraintEqualToAnchor:picker.bottomAnchor constant:16],
        [hintLabel.leadingAnchor constraintEqualToAnchor:self.view.leadingAnchor constant:20],
        [hintLabel.trailingAnchor constraintEqualToAnchor:self.view.trailingAnchor constant:-20],
    ]];
}

#pragma mark - Save Server URL

- (void)onSaveTapped {
    [self.serverURLField resignFirstResponder];
    NSString *urlStr = self.serverURLField.text;
    if (urlStr.length == 0) return;

    NSUserDefaults *shared = [[NSUserDefaults alloc] initWithSuiteName:kAppGroupIdentifier];
    [shared setObject:urlStr forKey:@"serverURL"];
    [shared synchronize];

    self.statusLabel.text = [NSString stringWithFormat:@"已保存: %@\n点击录制按钮开始", urlStr];
    self.statusLabel.textColor = [UIColor systemGreenColor];
    NSLog(@"[ViewController] Saved server URL: %@", urlStr);
}

- (BOOL)textFieldShouldReturn:(UITextField *)textField {
    [self onSaveTapped];
    return YES;
}

@end
