//
//  FMP4Muxer.h
//  ioscontroller
//
//  iOS 远程控制系统 - fMP4 封装器
//  将 H.264 NAL Units 封装为 fMP4 格式（init segment + media segments）
//  供浏览器端 MSE SourceBuffer 解码播放
//

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface FMP4Muxer : NSObject

/// 初始化 fMP4 封装器
/// @param sps H.264 SPS (Sequence Parameter Set) NAL Unit 数据
/// @param pps H.264 PPS (Picture Parameter Set) NAL Unit 数据
/// @param width 视频宽度（像素）
/// @param height 视频高度（像素）
- (instancetype)initWithSPS:(NSData *)sps PPS:(NSData *)pps width:(int)width height:(int)height;

/// 生成 fMP4 init segment（ftyp + moov boxes）
/// 包含视频轨道的 SPS/PPS 参数、分辨率、时间基等元信息
/// 在视频流开始时调用一次，发送给浏览器端初始化 SourceBuffer
/// @return init segment 二进制数据
- (NSData *)generateInitSegment;

/// 将单个 H.264 NAL Unit 封装为 fMP4 media segment（moof + mdat boxes）
/// @param nalUnit H.264 NAL Unit 数据（不含起始码，使用 4 字节长度前缀格式）
/// @param isKeyFrame 是否为关键帧（I 帧）
/// @param timestamp 显示时间戳（基于 timescale 90000）
/// @param duration 帧持续时间（基于 timescale 90000）
/// @return media segment 二进制数据
- (NSData *)muxNALUnit:(NSData *)nalUnit isKeyFrame:(BOOL)isKeyFrame timestamp:(uint64_t)timestamp duration:(uint64_t)duration;

- (instancetype)init NS_UNAVAILABLE;

@end

NS_ASSUME_NONNULL_END
