//
//  SampleHandler.h
//  BroadcastExtension
//

#import <ReplayKit/ReplayKit.h>
#import "H264Encoder.h"

@interface SampleHandler : RPBroadcastSampleHandler <H264EncoderDelegate, NSURLSessionWebSocketDelegate>

@end
