//
//  FMP4Muxer.m
//  ioscontroller
//
//  iOS 远程控制系统 - fMP4 封装器实现
//  手动构建 ISO BMFF (ISO 14496-12) 格式的 fMP4 boxes
//

#import "FMP4Muxer.h"

/// fMP4 timescale（与 H.264 常用时间基一致）
static const uint32_t kTimescale = 90000;

/// Track ID
static const uint32_t kTrackID = 1;

@interface FMP4Muxer ()

@property (nonatomic, strong) NSData *sps;
@property (nonatomic, strong) NSData *pps;
@property (nonatomic, assign) int width;
@property (nonatomic, assign) int height;
@property (nonatomic, assign) uint32_t sequenceNumber;

@end

@implementation FMP4Muxer

#pragma mark - Initialization

- (instancetype)initWithSPS:(NSData *)sps PPS:(NSData *)pps width:(int)width height:(int)height {
    self = [super init];
    if (self) {
        _sps = [sps copy];
        _pps = [pps copy];
        _width = width;
        _height = height;
        _sequenceNumber = 0;
    }
    return self;
}

#pragma mark - Helper: Write big-endian integers

static void writeUint32(NSMutableData *data, uint32_t value) {
    uint8_t bytes[4];
    bytes[0] = (value >> 24) & 0xFF;
    bytes[1] = (value >> 16) & 0xFF;
    bytes[2] = (value >> 8) & 0xFF;
    bytes[3] = value & 0xFF;
    [data appendBytes:bytes length:4];
}

static void writeUint16(NSMutableData *data, uint16_t value) {
    uint8_t bytes[2];
    bytes[0] = (value >> 8) & 0xFF;
    bytes[1] = value & 0xFF;
    [data appendBytes:bytes length:2];
}

static void writeUint8(NSMutableData *data, uint8_t value) {
    [data appendBytes:&value length:1];
}

static void writeUint64(NSMutableData *data, uint64_t value) {
    uint8_t bytes[8];
    bytes[0] = (value >> 56) & 0xFF;
    bytes[1] = (value >> 48) & 0xFF;
    bytes[2] = (value >> 40) & 0xFF;
    bytes[3] = (value >> 32) & 0xFF;
    bytes[4] = (value >> 24) & 0xFF;
    bytes[5] = (value >> 16) & 0xFF;
    bytes[6] = (value >> 8) & 0xFF;
    bytes[7] = value & 0xFF;
    [data appendBytes:bytes length:8];
}

static void writeBytes(NSMutableData *data, const void *bytes, NSUInteger length) {
    [data appendBytes:bytes length:length];
}

static void writeZeros(NSMutableData *data, NSUInteger count) {
    uint8_t zero = 0;
    for (NSUInteger i = 0; i < count; i++) {
        [data appendBytes:&zero length:1];
    }
}

/// Write a 4-character box type code
static void writeType(NSMutableData *data, const char *type) {
    [data appendBytes:type length:4];
}

#pragma mark - Box Builders

/// Build a complete box: 4-byte size + 4-byte type + content
static NSData *buildBox(const char *type, NSData *content) {
    NSMutableData *box = [NSMutableData dataWithCapacity:8 + content.length];
    writeUint32(box, (uint32_t)(8 + content.length));
    writeType(box, type);
    [box appendData:content];
    return box;
}

/// Build a full box: 4-byte size + 4-byte type + 1-byte version + 3-byte flags + content
static NSData *buildFullBox(const char *type, uint8_t version, uint32_t flags, NSData *content) {
    NSMutableData *box = [NSMutableData dataWithCapacity:12 + content.length];
    writeUint32(box, (uint32_t)(12 + content.length));
    writeType(box, type);
    writeUint8(box, version);
    uint8_t flagBytes[3];
    flagBytes[0] = (flags >> 16) & 0xFF;
    flagBytes[1] = (flags >> 8) & 0xFF;
    flagBytes[2] = flags & 0xFF;
    writeBytes(box, flagBytes, 3);
    [box appendData:content];
    return box;
}

#pragma mark - Init Segment Generation

- (NSData *)generateInitSegment {
    NSMutableData *initSegment = [NSMutableData data];

    // ftyp box
    NSData *ftyp = [self buildFtypBox];
    [initSegment appendData:ftyp];

    // moov box
    NSData *moov = [self buildMoovBox];
    [initSegment appendData:moov];

    return initSegment;
}

- (NSData *)buildFtypBox {
    NSMutableData *content = [NSMutableData data];
    writeType(content, "isom");          // major_brand
    writeUint32(content, 0x00000200);    // minor_version
    writeType(content, "isom");          // compatible_brands
    writeType(content, "iso6");
    writeType(content, "avc1");
    writeType(content, "mp41");
    return buildBox("ftyp", content);
}

- (NSData *)buildMoovBox {
    NSMutableData *content = [NSMutableData data];

    // mvhd (Movie Header Box)
    [content appendData:[self buildMvhdBox]];

    // trak (Track Box)
    [content appendData:[self buildTrakBox]];

    // mvex (Movie Extends Box) - required for fragmented MP4
    [content appendData:[self buildMvexBox]];

    return buildBox("moov", content);
}

- (NSData *)buildMvhdBox {
    NSMutableData *content = [NSMutableData data];
    writeUint32(content, 0);             // creation_time
    writeUint32(content, 0);             // modification_time
    writeUint32(content, kTimescale);    // timescale
    writeUint32(content, 0);             // duration (unknown for live)
    writeUint32(content, 0x00010000);    // rate (1.0 fixed-point)
    writeUint16(content, 0x0100);        // volume (1.0 fixed-point)
    writeZeros(content, 10);             // reserved
    // Unity matrix (3x3 identity in fixed-point)
    uint32_t matrix[] = {
        0x00010000, 0, 0,
        0, 0x00010000, 0,
        0, 0, 0x40000000
    };
    for (int i = 0; i < 9; i++) {
        writeUint32(content, matrix[i]);
    }
    writeZeros(content, 24);             // pre_defined
    writeUint32(content, 2);             // next_track_ID
    return buildFullBox("mvhd", 0, 0, content);
}

- (NSData *)buildTrakBox {
    NSMutableData *content = [NSMutableData data];

    // tkhd (Track Header Box)
    [content appendData:[self buildTkhdBox]];

    // mdia (Media Box)
    [content appendData:[self buildMdiaBox]];

    return buildBox("trak", content);
}

- (NSData *)buildTkhdBox {
    NSMutableData *content = [NSMutableData data];
    writeUint32(content, 0);             // creation_time
    writeUint32(content, 0);             // modification_time
    writeUint32(content, kTrackID);      // track_ID
    writeUint32(content, 0);             // reserved
    writeUint32(content, 0);             // duration (unknown for live)
    writeZeros(content, 8);              // reserved
    writeUint16(content, 0);             // layer
    writeUint16(content, 0);             // alternate_group
    writeUint16(content, 0);             // volume (0 for video)
    writeUint16(content, 0);             // reserved
    // Unity matrix
    uint32_t matrix[] = {
        0x00010000, 0, 0,
        0, 0x00010000, 0,
        0, 0, 0x40000000
    };
    for (int i = 0; i < 9; i++) {
        writeUint32(content, matrix[i]);
    }
    // width and height in fixed-point 16.16
    writeUint32(content, (uint32_t)self.width << 16);
    writeUint32(content, (uint32_t)self.height << 16);
    // flags: track_enabled | track_in_movie | track_in_preview
    return buildFullBox("tkhd", 0, 0x000003, content);
}

- (NSData *)buildMdiaBox {
    NSMutableData *content = [NSMutableData data];

    // mdhd (Media Header Box)
    [content appendData:[self buildMdhdBox]];

    // hdlr (Handler Reference Box)
    [content appendData:[self buildHdlrBox]];

    // minf (Media Information Box)
    [content appendData:[self buildMinfBox]];

    return buildBox("mdia", content);
}

- (NSData *)buildMdhdBox {
    NSMutableData *content = [NSMutableData data];
    writeUint32(content, 0);             // creation_time
    writeUint32(content, 0);             // modification_time
    writeUint32(content, kTimescale);    // timescale
    writeUint32(content, 0);             // duration (unknown for live)
    writeUint16(content, 0x55C4);        // language (undetermined)
    writeUint16(content, 0);             // pre_defined
    return buildFullBox("mdhd", 0, 0, content);
}

- (NSData *)buildHdlrBox {
    NSMutableData *content = [NSMutableData data];
    writeUint32(content, 0);             // pre_defined
    writeType(content, "vide");          // handler_type (video)
    writeZeros(content, 12);             // reserved
    // name (null-terminated string)
    const char *name = "VideoHandler";
    writeBytes(content, name, strlen(name) + 1);
    return buildFullBox("hdlr", 0, 0, content);
}

- (NSData *)buildMinfBox {
    NSMutableData *content = [NSMutableData data];

    // vmhd (Video Media Header Box)
    [content appendData:[self buildVmhdBox]];

    // dinf (Data Information Box)
    [content appendData:[self buildDinfBox]];

    // stbl (Sample Table Box)
    [content appendData:[self buildStblBox]];

    return buildBox("minf", content);
}

- (NSData *)buildVmhdBox {
    NSMutableData *content = [NSMutableData data];
    writeUint16(content, 0);             // graphicsmode
    writeZeros(content, 6);              // opcolor
    return buildFullBox("vmhd", 0, 0x000001, content);
}

- (NSData *)buildDinfBox {
    // dref box inside dinf
    NSMutableData *drefContent = [NSMutableData data];
    writeUint32(drefContent, 1);         // entry_count

    // url entry (self-contained)
    NSData *urlBox = buildFullBox("url ", 0, 0x000001, [NSData data]);
    [drefContent appendData:urlBox];

    NSData *dref = buildFullBox("dref", 0, 0, drefContent);
    return buildBox("dinf", dref);
}

- (NSData *)buildStblBox {
    NSMutableData *content = [NSMutableData data];

    // stsd (Sample Description Box)
    [content appendData:[self buildStsdBox]];

    // stts (Decoding Time to Sample Box) - empty for fragmented
    NSMutableData *sttsContent = [NSMutableData data];
    writeUint32(sttsContent, 0);         // entry_count
    [content appendData:buildFullBox("stts", 0, 0, sttsContent)];

    // stsc (Sample to Chunk Box) - empty for fragmented
    NSMutableData *stscContent = [NSMutableData data];
    writeUint32(stscContent, 0);         // entry_count
    [content appendData:buildFullBox("stsc", 0, 0, stscContent)];

    // stsz (Sample Size Box) - empty for fragmented
    NSMutableData *stszContent = [NSMutableData data];
    writeUint32(stszContent, 0);         // sample_size
    writeUint32(stszContent, 0);         // sample_count
    [content appendData:buildFullBox("stsz", 0, 0, stszContent)];

    // stco (Chunk Offset Box) - empty for fragmented
    NSMutableData *stcoContent = [NSMutableData data];
    writeUint32(stcoContent, 0);         // entry_count
    [content appendData:buildFullBox("stco", 0, 0, stcoContent)];

    return buildBox("stbl", content);
}

- (NSData *)buildStsdBox {
    NSMutableData *content = [NSMutableData data];
    writeUint32(content, 1);             // entry_count

    // avc1 sample entry
    [content appendData:[self buildAvc1Box]];

    return buildFullBox("stsd", 0, 0, content);
}

- (NSData *)buildAvc1Box {
    NSMutableData *content = [NSMutableData data];
    writeZeros(content, 6);              // reserved
    writeUint16(content, 1);             // data_reference_index
    writeZeros(content, 16);             // pre_defined + reserved
    writeUint16(content, (uint16_t)self.width);   // width
    writeUint16(content, (uint16_t)self.height);  // height
    writeUint32(content, 0x00480000);    // horizresolution (72 dpi)
    writeUint32(content, 0x00480000);    // vertresolution (72 dpi)
    writeUint32(content, 0);             // reserved
    writeUint16(content, 1);             // frame_count
    writeZeros(content, 32);             // compressorname
    writeUint16(content, 0x0018);        // depth (24-bit color)
    writeUint16(content, 0xFFFF);        // pre_defined (-1)

    // avcC (AVC Decoder Configuration Record)
    [content appendData:[self buildAvcCBox]];

    return buildBox("avc1", content);
}

- (NSData *)buildAvcCBox {
    NSMutableData *content = [NSMutableData data];

    const uint8_t *spsBytes = (const uint8_t *)self.sps.bytes;

    writeUint8(content, 1);              // configurationVersion
    writeUint8(content, spsBytes[1]);    // AVCProfileIndication
    writeUint8(content, spsBytes[2]);    // profile_compatibility
    writeUint8(content, spsBytes[3]);    // AVCLevelIndication
    writeUint8(content, 0xFF);           // lengthSizeMinusOne = 3 (4-byte NAL length)

    // SPS
    writeUint8(content, 0xE1);           // numOfSequenceParameterSets = 1 (with reserved bits)
    writeUint16(content, (uint16_t)self.sps.length);
    [content appendData:self.sps];

    // PPS
    writeUint8(content, 1);              // numOfPictureParameterSets = 1
    writeUint16(content, (uint16_t)self.pps.length);
    [content appendData:self.pps];

    return buildBox("avcC", content);
}

- (NSData *)buildMvexBox {
    NSMutableData *content = [NSMutableData data];

    // trex (Track Extends Box)
    NSMutableData *trexContent = [NSMutableData data];
    writeUint32(trexContent, kTrackID);  // track_ID
    writeUint32(trexContent, 1);         // default_sample_description_index
    writeUint32(trexContent, 0);         // default_sample_duration
    writeUint32(trexContent, 0);         // default_sample_size
    writeUint32(trexContent, 0);         // default_sample_flags
    [content appendData:buildFullBox("trex", 0, 0, trexContent)];

    return buildBox("mvex", content);
}

#pragma mark - Media Segment Generation

- (NSData *)muxNALUnit:(NSData *)nalUnit isKeyFrame:(BOOL)isKeyFrame timestamp:(uint64_t)timestamp duration:(uint64_t)duration {
    self.sequenceNumber++;

    // Build NAL data with 4-byte length prefix for mdat
    NSMutableData *nalData = [NSMutableData data];
    writeUint32(nalData, (uint32_t)nalUnit.length);
    [nalData appendData:nalUnit];

    // Build moof box
    NSData *moof = [self buildMoofBoxWithNALDataSize:(uint32_t)nalData.length
                                          isKeyFrame:isKeyFrame
                                           timestamp:timestamp
                                            duration:duration];

    // Patch data_offset in trun: moof_size + 8 (mdat box header)
    NSMutableData *patchedMoof = [moof mutableCopy];
    uint32_t dataOffset = (uint32_t)moof.length + 8;
    [self patchDataOffset:dataOffset inMoof:patchedMoof];

    NSMutableData *segment = [NSMutableData data];
    [segment appendData:patchedMoof];

    // mdat box
    NSData *mdat = buildBox("mdat", nalData);
    [segment appendData:mdat];

    return segment;
}

- (NSData *)buildMoofBoxWithNALDataSize:(uint32_t)nalDataSize
                             isKeyFrame:(BOOL)isKeyFrame
                              timestamp:(uint64_t)timestamp
                               duration:(uint64_t)duration {
    NSMutableData *content = [NSMutableData data];

    // mfhd (Movie Fragment Header Box)
    NSMutableData *mfhdContent = [NSMutableData data];
    writeUint32(mfhdContent, self.sequenceNumber);
    [content appendData:buildFullBox("mfhd", 0, 0, mfhdContent)];

    // traf (Track Fragment Box)
    [content appendData:[self buildTrafBoxWithNALDataSize:nalDataSize
                                              isKeyFrame:isKeyFrame
                                               timestamp:timestamp
                                                duration:duration]];

    return buildBox("moof", content);
}

- (NSData *)buildTrafBoxWithNALDataSize:(uint32_t)nalDataSize
                             isKeyFrame:(BOOL)isKeyFrame
                              timestamp:(uint64_t)timestamp
                               duration:(uint64_t)duration {
    NSMutableData *content = [NSMutableData data];

    // tfhd (Track Fragment Header Box)
    // flags: default-base-is-moof (0x020000)
    NSMutableData *tfhdContent = [NSMutableData data];
    writeUint32(tfhdContent, kTrackID);
    [content appendData:buildFullBox("tfhd", 0, 0x020000, tfhdContent)];

    // tfdt (Track Fragment Decode Time Box) - version 1 for 64-bit time
    NSMutableData *tfdtContent = [NSMutableData data];
    writeUint64(tfdtContent, timestamp);
    [content appendData:buildFullBox("tfdt", 1, 0, tfdtContent)];

    // trun (Track Run Box)
    [content appendData:[self buildTrunBoxWithNALDataSize:nalDataSize
                                              isKeyFrame:isKeyFrame
                                                duration:duration]];

    return buildBox("traf", content);
}

- (NSData *)buildTrunBoxWithNALDataSize:(uint32_t)nalDataSize
                             isKeyFrame:(BOOL)isKeyFrame
                               duration:(uint64_t)duration {
    // trun flags:
    // 0x000001 = data-offset-present
    // 0x000100 = sample-duration-present
    // 0x000200 = sample-size-present
    // 0x000400 = sample-flags-present
    uint32_t trunFlags = 0x000001 | 0x000100 | 0x000200 | 0x000400;

    NSMutableData *content = [NSMutableData data];
    writeUint32(content, 1);             // sample_count

    // data_offset: offset from moof start to mdat payload
    // This will be calculated as: moof_size + 8 (mdat header)
    // We use a placeholder and fix it after building the moof
    // For simplicity, we calculate: traf header sizes + moof header
    // Actually, the data_offset is relative to the start of the containing moof box.
    // We'll compute it after we know the moof size.
    // For now, write a placeholder (will be patched)
    uint32_t dataOffsetPlaceholder = 0;
    writeUint32(content, dataOffsetPlaceholder);

    // sample_duration
    writeUint32(content, (uint32_t)duration);

    // sample_size
    writeUint32(content, nalDataSize);

    // sample_flags
    // For key frames: depends_on = 2 (does not depend), is_non_sync = 0
    // For non-key frames: depends_on = 1 (depends on others), is_non_sync = 1
    uint32_t sampleFlags;
    if (isKeyFrame) {
        sampleFlags = 0x02000000; // sample_depends_on = 2 (does not depend on others)
    } else {
        sampleFlags = 0x01010000; // sample_depends_on = 1, sample_is_non_sync_sample = 1
    }
    writeUint32(content, sampleFlags);

    NSData *trunBox = buildFullBox("trun", 0, trunFlags, content);

    return trunBox;
}

/// Patch the data_offset field in the trun box within the moof
- (void)patchDataOffset:(uint32_t)dataOffset inMoof:(NSMutableData *)moof {
    // Search for "trun" box type in the moof data
    const uint8_t *bytes = (const uint8_t *)moof.bytes;
    NSUInteger length = moof.length;

    for (NSUInteger i = 0; i + 4 <= length; i++) {
        if (bytes[i] == 't' && bytes[i+1] == 'r' && bytes[i+2] == 'u' && bytes[i+3] == 'n') {
            // Found trun box type at position i
            // After type: version (1 byte) + flags (3 bytes) + sample_count (4 bytes) + data_offset (4 bytes)
            NSUInteger dataOffsetPos = i + 4 + 1 + 3 + 4; // type + version + flags + sample_count
            if (dataOffsetPos + 4 <= length) {
                uint8_t offsetBytes[4];
                offsetBytes[0] = (dataOffset >> 24) & 0xFF;
                offsetBytes[1] = (dataOffset >> 16) & 0xFF;
                offsetBytes[2] = (dataOffset >> 8) & 0xFF;
                offsetBytes[3] = dataOffset & 0xFF;
                [moof replaceBytesInRange:NSMakeRange(dataOffsetPos, 4) withBytes:offsetBytes];
            }
            break;
        }
    }
}

@end
