//
//  H264Encoder.m
//  BroadcastExtension
//
//  VTCompressionSession 硬件编码器实现
//  配置 H.264 Baseline Profile、实时编码模式
//

#import "H264Encoder.h"
#import <VideoToolbox/VideoToolbox.h>

@interface H264Encoder ()

/// VideoToolbox 压缩会话
@property (nonatomic, assign) VTCompressionSessionRef compressionSession;

/// 视频宽度
@property (nonatomic, assign) int width;

/// 视频高度
@property (nonatomic, assign) int height;

/// 目标帧率
@property (nonatomic, assign) int fps;

/// 目标码率
@property (nonatomic, assign) int bitrate;

/// 是否已输出 SPS/PPS
@property (nonatomic, assign) BOOL spsAndPpsExtracted;
@property (nonatomic, assign) BOOL nextFrameIsKeyframe;

@end

@implementation H264Encoder

#pragma mark - Initialization

- (instancetype)initWithWidth:(int)width height:(int)height fps:(int)fps bitrate:(int)bitrate {
    self = [super init];
    if (self) {
        _width = width;
        _height = height;
        _fps = fps;
        _bitrate = bitrate;
        _spsAndPpsExtracted = NO;
        _compressionSession = NULL;

        [self setupCompressionSession];
    }
    return self;
}

- (void)dealloc {
    [self stopEncoding];
}

#pragma mark - Session Setup

- (void)setupCompressionSession {
    // 创建 VTCompressionSession
    OSStatus status = VTCompressionSessionCreate(
        kCFAllocatorDefault,
        self.width,
        self.height,
        kCMVideoCodecType_H264,
        NULL,   // encoderSpecification
        NULL,   // sourceImageBufferAttributes
        kCFAllocatorDefault,
        compressionOutputCallback,
        (__bridge void *)self,
        &_compressionSession
    );

    if (status != noErr) {
        NSLog(@"[H264Encoder] Failed to create VTCompressionSession: %d", (int)status);
        return;
    }

    // 配置 H.264 Baseline Profile
    VTSessionSetProperty(_compressionSession,
                         kVTCompressionPropertyKey_ProfileLevel,
                         kVTProfileLevel_H264_Baseline_AutoLevel);

    // 实时编码模式
    VTSessionSetProperty(_compressionSession,
                         kVTCompressionPropertyKey_RealTime,
                         kCFBooleanTrue);

    // 目标码率
    VTSessionSetProperty(_compressionSession,
                         kVTCompressionPropertyKey_AverageBitRate,
                         (__bridge CFTypeRef)@(self.bitrate));

    // 目标帧率
    VTSessionSetProperty(_compressionSession,
                         kVTCompressionPropertyKey_ExpectedFrameRate,
                         (__bridge CFTypeRef)@(self.fps));

    // 关键帧间隔（每 2 秒一个关键帧）
    VTSessionSetProperty(_compressionSession,
                         kVTCompressionPropertyKey_MaxKeyFrameInterval,
                         (__bridge CFTypeRef)@(self.fps * 2));

    // 允许帧重排序关闭（Baseline Profile 不使用 B 帧）
    VTSessionSetProperty(_compressionSession,
                         kVTCompressionPropertyKey_AllowFrameReordering,
                         kCFBooleanFalse);

    // 准备编码
    VTCompressionSessionPrepareToEncodeFrames(_compressionSession);

    NSLog(@"[H264Encoder] Compression session created: %dx%d @ %dfps, bitrate=%d",
          self.width, self.height, self.fps, self.bitrate);
}

#pragma mark - Encoding

- (void)encodePixelBuffer:(CVPixelBufferRef)pixelBuffer presentationTime:(CMTime)pts {
    if (!self.compressionSession) {
        NSLog(@"[H264Encoder] Compression session not available");
        return;
    }

    // 如果需要强制关键帧
    NSDictionary *frameProps = nil;
    if (self.nextFrameIsKeyframe) {
        self.nextFrameIsKeyframe = NO;
        frameProps = @{ (__bridge NSString *)kVTEncodeFrameOptionKey_ForceKeyFrame: @YES };
        NSLog(@"[H264Encoder] Forcing keyframe");
    }

    OSStatus status = VTCompressionSessionEncodeFrame(
        self.compressionSession,
        pixelBuffer,
        pts,
        kCMTimeInvalid,
        (__bridge CFDictionaryRef)frameProps,
        NULL,
        NULL
    );

    if (status != noErr) {
        NSLog(@"[H264Encoder] Failed to encode frame: %d", (int)status);
    }
}

- (void)forceKeyframe {
    self.nextFrameIsKeyframe = YES;
}

- (void)stopEncoding {
    if (self.compressionSession) {
        VTCompressionSessionCompleteFrames(self.compressionSession, kCMTimeInvalid);
        VTCompressionSessionInvalidate(self.compressionSession);
        CFRelease(self.compressionSession);
        self.compressionSession = NULL;
        NSLog(@"[H264Encoder] Compression session stopped and released");
    }
}

#pragma mark - Compression Output Callback

/// VTCompressionSession 编码输出回调
static void compressionOutputCallback(void *outputCallbackRefCon,
                                       void *sourceFrameRefCon,
                                       OSStatus status,
                                       VTEncodeInfoFlags infoFlags,
                                       CMSampleBufferRef sampleBuffer) {
    if (status != noErr) {
        NSLog(@"[H264Encoder] Encoding error in callback: %d", (int)status);
        return;
    }

    if (!CMSampleBufferDataIsReady(sampleBuffer)) {
        NSLog(@"[H264Encoder] Sample buffer data is not ready");
        return;
    }

    H264Encoder *encoder = (__bridge H264Encoder *)outputCallbackRefCon;

    // 检查是否为关键帧
    BOOL isKeyFrame = NO;
    CFArrayRef attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, false);
    if (attachments && CFArrayGetCount(attachments) > 0) {
        CFDictionaryRef attachment = CFArrayGetValueAtIndex(attachments, 0);
        CFBooleanRef notSync;
        if (CFDictionaryGetValueIfPresent(attachment,
                                          kCMSampleAttachmentKey_NotSync,
                                          (const void **)&notSync)) {
            isKeyFrame = !CFBooleanGetValue(notSync);
        } else {
            // 如果 NotSync 不存在，默认为关键帧
            isKeyFrame = YES;
        }
    }

    // 关键帧时提取 SPS/PPS（只提取一次）
    if (isKeyFrame && !encoder.spsAndPpsExtracted) {
        [encoder extractSPSAndPPS:sampleBuffer];
    }

    // 提取 NAL Units
    [encoder extractNALUnits:sampleBuffer isKeyFrame:isKeyFrame];
}

#pragma mark - NAL Unit Extraction

/// 从关键帧中提取 SPS 和 PPS 参数集
- (void)extractSPSAndPPS:(CMSampleBufferRef)sampleBuffer {
    CMFormatDescriptionRef formatDescription = CMSampleBufferGetFormatDescription(sampleBuffer);
    if (!formatDescription) return;

    // 提取 SPS
    size_t spsSize = 0;
    size_t spsCount = 0;
    const uint8_t *spsData = NULL;

    OSStatus status = CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
        formatDescription, 0, &spsData, &spsSize, &spsCount, NULL);

    if (status != noErr || !spsData) {
        NSLog(@"[H264Encoder] Failed to get SPS: %d", (int)status);
        return;
    }

    // 提取 PPS
    size_t ppsSize = 0;
    const uint8_t *ppsData = NULL;

    status = CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
        formatDescription, 1, &ppsData, &ppsSize, NULL, NULL);

    if (status != noErr || !ppsData) {
        NSLog(@"[H264Encoder] Failed to get PPS: %d", (int)status);
        return;
    }

    NSData *sps = [NSData dataWithBytes:spsData length:spsSize];
    NSData *pps = [NSData dataWithBytes:ppsData length:ppsSize];

    NSLog(@"[H264Encoder] Extracted SPS (%zu bytes) and PPS (%zu bytes)", spsSize, ppsSize);

    // 通知代理
    if ([self.delegate respondsToSelector:@selector(encoder:didOutputSPS:PPS:)]) {
        [self.delegate encoder:self didOutputSPS:sps PPS:pps];
    }

    self.spsAndPpsExtracted = YES;
}

/// 从编码后的 CMSampleBuffer 中提取 H.264 NAL Units
- (void)extractNALUnits:(CMSampleBufferRef)sampleBuffer isKeyFrame:(BOOL)isKeyFrame {
    CMBlockBufferRef blockBuffer = CMSampleBufferGetDataBuffer(sampleBuffer);
    if (!blockBuffer) return;

    size_t totalLength = 0;
    size_t dataLength = 0;
    char *dataPointer = NULL;

    OSStatus status = CMBlockBufferGetDataPointer(blockBuffer, 0, &dataLength, &totalLength, &dataPointer);
    if (status != noErr || !dataPointer) {
        NSLog(@"[H264Encoder] Failed to get block buffer data: %d", (int)status);
        return;
    }

    // 获取 NAL Unit 长度前缀大小（通常为 4 字节）
    CMFormatDescriptionRef formatDescription = CMSampleBufferGetFormatDescription(sampleBuffer);
    int nalUnitHeaderLength = 0;
    if (formatDescription) {
        CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
            formatDescription, 0, NULL, NULL, NULL, &nalUnitHeaderLength);
    }
    if (nalUnitHeaderLength == 0) {
        nalUnitHeaderLength = 4; // 默认 4 字节
    }

    // 遍历所有 NAL Units
    size_t offset = 0;
    while (offset < totalLength) {
        // 读取 NAL Unit 长度
        uint32_t nalLength = 0;
        if (nalUnitHeaderLength == 4) {
            memcpy(&nalLength, dataPointer + offset, 4);
            nalLength = CFSwapInt32BigToHost(nalLength);
        } else if (nalUnitHeaderLength == 2) {
            uint16_t len16 = 0;
            memcpy(&len16, dataPointer + offset, 2);
            nalLength = CFSwapInt16BigToHost(len16);
        } else if (nalUnitHeaderLength == 1) {
            nalLength = *(uint8_t *)(dataPointer + offset);
        }
        offset += nalUnitHeaderLength;

        if (nalLength == 0 || offset + nalLength > totalLength) {
            break;
        }

        // 提取 NAL Unit 数据
        NSData *nalUnit = [NSData dataWithBytes:dataPointer + offset length:nalLength];
        offset += nalLength;

        // 通知代理
        if ([self.delegate respondsToSelector:@selector(encoder:didOutputNALUnit:isKeyFrame:)]) {
            [self.delegate encoder:self didOutputNALUnit:nalUnit isKeyFrame:isKeyFrame];
        }
    }
}

@end
