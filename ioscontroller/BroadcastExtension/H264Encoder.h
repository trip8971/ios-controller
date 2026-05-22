//
//  H264Encoder.h
//  BroadcastExtension
//
//  封装 VTCompressionSession 硬件编码器
//  将 CVPixelBuffer 编码为 H.264 NAL Units
//

#import <Foundation/Foundation.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>

@class H264Encoder;

@protocol H264EncoderDelegate <NSObject>

/// 编码器输出 SPS/PPS 参数集
- (void)encoder:(H264Encoder *)encoder didOutputSPS:(NSData *)sps PPS:(NSData *)pps;

/// 编码器输出 H.264 NAL Unit
- (void)encoder:(H264Encoder *)encoder didOutputNALUnit:(NSData *)nalUnit isKeyFrame:(BOOL)isKeyFrame;

@end

@interface H264Encoder : NSObject

/// 编码器代理
@property (nonatomic, weak) id<H264EncoderDelegate> delegate;

/// 初始化编码器
/// @param width 视频宽度（像素）
/// @param height 视频高度（像素）
/// @param fps 目标帧率
/// @param bitrate 目标码率（bps）
- (instancetype)initWithWidth:(int)width height:(int)height fps:(int)fps bitrate:(int)bitrate;

/// 编码一帧像素数据
/// @param pixelBuffer 待编码的像素缓冲区
/// @param pts 显示时间戳
- (void)encodePixelBuffer:(CVPixelBufferRef)pixelBuffer presentationTime:(CMTime)pts;

/// 停止编码并释放资源
- (void)stopEncoding;

/// 强制下一帧为关键帧
- (void)forceKeyframe;

@end
