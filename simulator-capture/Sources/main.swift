import Foundation
import ScreenCaptureKit
import VideoToolbox
import CoreMedia
import AppKit

// MARK: - Config

let serverURL = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "ws://localhost:8080"
let targetFPS = 60
let bitrate = 12_000_000

print("[Capture] Server: \(serverURL)")
print("[Capture] FPS: \(targetFPS), Bitrate: \(bitrate)")

// MARK: - FMP4 Muxer (minimal)

class FMP4Muxer {
    let sps: Data
    let pps: Data
    let width: Int
    let height: Int
    var seq: UInt32 = 0

    init(sps: Data, pps: Data, width: Int, height: Int) {
        self.sps = sps; self.pps = pps; self.width = width; self.height = height
    }

    func generateInitSegment() -> Data {
        var d = Data()
        d.append(buildFtyp())
        d.append(buildMoov())
        return d
    }

    func muxNALUnit(_ nalu: Data, isKey: Bool, ts: UInt64, dur: UInt64) -> Data {
        seq += 1
        // NAL data with 4-byte length prefix
        var nalData = Data()
        nalData.appendU32(UInt32(nalu.count))
        nalData.append(nalu)

        let moof = buildMoof(nalDataSize: UInt32(nalData.count), isKey: isKey, ts: ts, dur: dur)
        var segment = Data()
        segment.append(moof)
        segment.append(box("mdat", nalData))
        return segment
    }

    // MARK: - Box builders

    private func buildFtyp() -> Data {
        var c = Data()
        c.append("isom".data(using: .ascii)!)
        c.appendU32(0x200)
        for b in ["isom", "iso6", "avc1", "mp41"] { c.append(b.data(using: .ascii)!) }
        return box("ftyp", c)
    }

    private func buildMoov() -> Data {
        var c = Data()
        c.append(buildMvhd())
        c.append(buildTrak())
        c.append(buildMvex())
        return box("moov", c)
    }

    private func buildMvhd() -> Data {
        var c = Data()
        c.appendU32(0); c.appendU32(0); c.appendU32(90000); c.appendU32(0)
        c.appendU32(0x00010000); c.appendU16(0x0100); c.appendZeros(10)
        let matrix: [UInt32] = [0x00010000,0,0, 0,0x00010000,0, 0,0,0x40000000]
        for m in matrix { c.appendU32(m) }
        c.appendZeros(24); c.appendU32(2)
        return fullBox("mvhd", 0, 0, c)
    }

    private func buildTrak() -> Data {
        var c = Data()
        c.append(buildTkhd())
        c.append(buildMdia())
        return box("trak", c)
    }

    private func buildTkhd() -> Data {
        var c = Data()
        c.appendU32(0); c.appendU32(0); c.appendU32(1); c.appendU32(0); c.appendU32(0)
        c.appendZeros(8); c.appendU16(0); c.appendU16(0); c.appendU16(0); c.appendU16(0)
        let matrix: [UInt32] = [0x00010000,0,0, 0,0x00010000,0, 0,0,0x40000000]
        for m in matrix { c.appendU32(m) }
        c.appendU32(UInt32(width) << 16); c.appendU32(UInt32(height) << 16)
        return fullBox("tkhd", 0, 3, c)
    }

    private func buildMdia() -> Data {
        var c = Data()
        // mdhd
        var mdhd = Data()
        mdhd.appendU32(0); mdhd.appendU32(0); mdhd.appendU32(90000); mdhd.appendU32(0)
        mdhd.appendU16(0x55C4); mdhd.appendU16(0)
        c.append(fullBox("mdhd", 0, 0, mdhd))
        // hdlr
        var hdlr = Data()
        hdlr.appendU32(0); hdlr.append("vide".data(using: .ascii)!); hdlr.appendZeros(12)
        hdlr.append("VideoHandler\0".data(using: .utf8)!)
        c.append(fullBox("hdlr", 0, 0, hdlr))
        // minf
        c.append(buildMinf())
        return box("mdia", c)
    }

    private func buildMinf() -> Data {
        var c = Data()
        var vmhd = Data(); vmhd.appendU16(0); vmhd.appendZeros(6)
        c.append(fullBox("vmhd", 0, 1, vmhd))
        // dinf
        var dref = Data(); dref.appendU32(1); dref.append(fullBox("url ", 0, 1, Data()))
        c.append(box("dinf", fullBox("dref", 0, 0, dref)))
        // stbl
        c.append(buildStbl())
        return box("minf", c)
    }

    private func buildStbl() -> Data {
        var c = Data()
        // stsd
        var stsd = Data(); stsd.appendU32(1); stsd.append(buildAvc1())
        c.append(fullBox("stsd", 0, 0, stsd))
        var e = Data(); e.appendU32(0)
        c.append(fullBox("stts", 0, 0, e))
        c.append(fullBox("stsc", 0, 0, e))
        var sz = Data(); sz.appendU32(0); sz.appendU32(0)
        c.append(fullBox("stsz", 0, 0, sz))
        c.append(fullBox("stco", 0, 0, e))
        return box("stbl", c)
    }

    private func buildAvc1() -> Data {
        var c = Data()
        c.appendZeros(6); c.appendU16(1); c.appendZeros(16)
        c.appendU16(UInt16(width)); c.appendU16(UInt16(height))
        c.appendU32(0x00480000); c.appendU32(0x00480000); c.appendU32(0)
        c.appendU16(1); c.appendZeros(32); c.appendU16(0x0018); c.appendU16(0xFFFF)
        c.append(buildAvcC())
        return box("avc1", c)
    }

    private func buildAvcC() -> Data {
        var c = Data()
        c.appendU8(1)
        c.appendU8(sps[1]); c.appendU8(sps[2]); c.appendU8(sps[3])
        c.appendU8(0xFF); c.appendU8(0xE1)
        c.appendU16(UInt16(sps.count)); c.append(sps)
        c.appendU8(1)
        c.appendU16(UInt16(pps.count)); c.append(pps)
        return box("avcC", c)
    }

    private func buildMvex() -> Data {
        var trex = Data()
        trex.appendU32(1); trex.appendU32(1); trex.appendU32(0); trex.appendU32(0); trex.appendU32(0)
        return box("mvex", fullBox("trex", 0, 0, trex))
    }

    private func buildMoof(nalDataSize: UInt32, isKey: Bool, ts: UInt64, dur: UInt64) -> Data {
        var c = Data()
        var mfhd = Data(); mfhd.appendU32(seq)
        c.append(fullBox("mfhd", 0, 0, mfhd))
        c.append(buildTraf(nalDataSize: nalDataSize, isKey: isKey, ts: ts, dur: dur))
        let moofData = box("moof", c)

        // Patch data_offset in trun
        var patched = moofData
        let dataOffset = UInt32(moofData.count) + 8
        if let trunPos = findBoxOffset(patched, type: "trun") {
            let offsetPos = trunPos + 4 + 1 + 3 + 4 // type + ver + flags + sample_count
            patched[offsetPos] = UInt8((dataOffset >> 24) & 0xFF)
            patched[offsetPos+1] = UInt8((dataOffset >> 16) & 0xFF)
            patched[offsetPos+2] = UInt8((dataOffset >> 8) & 0xFF)
            patched[offsetPos+3] = UInt8(dataOffset & 0xFF)
        }
        return patched
    }

    private func buildTraf(nalDataSize: UInt32, isKey: Bool, ts: UInt64, dur: UInt64) -> Data {
        var c = Data()
        var tfhd = Data(); tfhd.appendU32(1)
        c.append(fullBox("tfhd", 0, 0x020000, tfhd))
        var tfdt = Data(); tfdt.appendU64(ts)
        c.append(fullBox("tfdt", 1, 0, tfdt))
        // trun
        let flags: UInt32 = 0x000001 | 0x000100 | 0x000200 | 0x000400
        var trun = Data()
        trun.appendU32(1) // sample_count
        trun.appendU32(0) // data_offset placeholder
        trun.appendU32(UInt32(dur))
        trun.appendU32(nalDataSize)
        trun.appendU32(isKey ? 0x02000000 : 0x01010000)
        c.append(fullBox("trun", 0, flags, trun))
        return box("traf", c)
    }

    private func findBoxOffset(_ data: Data, type: String) -> Int? {
        let typeBytes = Array(type.utf8)
        for i in 0..<(data.count - 4) {
            if data[i] == typeBytes[0] && data[i+1] == typeBytes[1] &&
               data[i+2] == typeBytes[2] && data[i+3] == typeBytes[3] { return i }
        }
        return nil
    }

    private func box(_ type: String, _ content: Data) -> Data {
        var d = Data()
        d.appendU32(UInt32(8 + content.count))
        d.append(type.data(using: .ascii)!)
        d.append(content)
        return d
    }

    private func fullBox(_ type: String, _ ver: UInt8, _ flags: UInt32, _ content: Data) -> Data {
        var d = Data()
        d.appendU32(UInt32(12 + content.count))
        d.append(type.data(using: .ascii)!)
        d.appendU8(ver)
        d.appendU8(UInt8((flags >> 16) & 0xFF))
        d.appendU8(UInt8((flags >> 8) & 0xFF))
        d.appendU8(UInt8(flags & 0xFF))
        d.append(content)
        return d
    }
}

extension Data {
    mutating func appendU8(_ v: UInt8) { append(v) }
    mutating func appendU16(_ v: UInt16) { append(UInt8((v >> 8) & 0xFF)); append(UInt8(v & 0xFF)) }
    mutating func appendU32(_ v: UInt32) {
        append(UInt8((v >> 24) & 0xFF)); append(UInt8((v >> 16) & 0xFF))
        append(UInt8((v >> 8) & 0xFF)); append(UInt8(v & 0xFF))
    }
    mutating func appendU64(_ v: UInt64) {
        appendU32(UInt32((v >> 32) & 0xFFFFFFFF)); appendU32(UInt32(v & 0xFFFFFFFF))
    }
    mutating func appendZeros(_ n: Int) { append(contentsOf: [UInt8](repeating: 0, count: n)) }
}

// MARK: - WebSocket Client

class WSClient: NSObject, URLSessionWebSocketDelegate {
    var task: URLSessionWebSocketTask?
    var session: URLSession!
    var connected = false
    let url: URL

    init(url: URL) {
        self.url = url
        super.init()
        session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
    }

    func connect() {
        task = session.webSocketTask(with: url)
        task?.resume()
    }

    func sendBinary(_ data: Data) {
        guard connected else { return }
        task?.send(.data(data)) { err in
            if let err = err { print("[WS] Send error: \(err.localizedDescription)") }
        }
    }

    func sendJSON(_ dict: [String: Any]) {
        guard connected, let data = try? JSONSerialization.data(withJSONObject: dict) else { return }
        let str = String(data: data, encoding: .utf8)!
        task?.send(.string(str)) { err in
            if let err = err { print("[WS] Send error: \(err.localizedDescription)") }
        }
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol p: String?) {
        print("[WS] Connected")
        connected = true
        sendJSON(["type": "register", "role": "device"])
        print("[WS] Registered as device")
        receiveLoop()
    }

    private func receiveLoop() {
        task?.receive { [weak self] result in
            switch result {
            case .success(let msg):
                if case .string(let str) = msg { self?.onMessage?(str) }
                self?.receiveLoop()
            case .failure(let err):
                print("[WS] Receive error: \(err.localizedDescription)")
            }
        }
    }

    var onMessage: ((String) -> Void)?

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith code: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        print("[WS] Closed")
        connected = false
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error = error {
            print("[WS] Error: \(error.localizedDescription)")
            connected = false
            // Reconnect after 3s
            DispatchQueue.global().asyncAfter(deadline: .now() + 3) { [weak self] in
                print("[WS] Reconnecting...")
                self?.connect()
            }
        }
    }
}

// MARK: - H264 Encoder

class H264Encoder {
    var session: VTCompressionSession?
    var sps: Data?
    var pps: Data?
    var onSPSPPS: ((Data, Data) -> Void)?
    var onNALU: ((Data, Bool) -> Void)?
    var nextFrameIsKeyframe = false

    func forceKeyframe() {
        nextFrameIsKeyframe = true
        print("[Encoder] Keyframe requested")
    }

    init(width: Int, height: Int, fps: Int, bitrate: Int) {
        var s: VTCompressionSession?
        VTCompressionSessionCreate(allocator: nil, width: Int32(width), height: Int32(height),
                                   codecType: kCMVideoCodecType_H264, encoderSpecification: nil,
                                   imageBufferAttributes: nil, compressedDataAllocator: nil,
                                   outputCallback: nil, refcon: nil, compressionSessionOut: &s)
        guard let session = s else { print("[Encoder] Failed to create session"); return }
        self.session = session

        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ProfileLevel, value: kVTProfileLevel_H264_Baseline_AutoLevel)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AverageBitRate, value: bitrate as CFNumber)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ExpectedFrameRate, value: fps as CFNumber)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_MaxKeyFrameInterval, value: (fps * 2) as CFNumber)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse)
        VTCompressionSessionPrepareToEncodeFrames(session)
        print("[Encoder] Created \(width)x\(height) @ \(fps)fps")
    }

    func encode(_ pixelBuffer: CVPixelBuffer, pts: CMTime) {
        guard let session = session else { return }

        var props: CFDictionary? = nil
        if nextFrameIsKeyframe {
            nextFrameIsKeyframe = false
            props = [kVTEncodeFrameOptionKey_ForceKeyFrame: true] as CFDictionary
            print("[Encoder] Forcing keyframe")
        }

        VTCompressionSessionEncodeFrame(session, imageBuffer: pixelBuffer, presentationTimeStamp: pts,
                                        duration: .invalid, frameProperties: props, infoFlagsOut: nil) {
            [weak self] status, _, sampleBuffer in
            guard status == noErr, let sb = sampleBuffer, CMSampleBufferDataIsReady(sb) else { return }
            self?.processSampleBuffer(sb)
        }
    }

    private func processSampleBuffer(_ sb: CMSampleBuffer) {
        let attachments = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[CFString: Any]]
        let isKey = !(attachments?.first?[kCMSampleAttachmentKey_NotSync] as? Bool ?? false)

        if isKey, sps == nil {
            extractSPSPPS(sb)
        }

        guard let blockBuffer = CMSampleBufferGetDataBuffer(sb) else { return }
        var length = 0
        var dataPointer: UnsafeMutablePointer<Int8>?
        CMBlockBufferGetDataPointer(blockBuffer, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &length, dataPointerOut: &dataPointer)
        guard let ptr = dataPointer else { return }

        var offset = 0
        while offset < length {
            var naluLen: UInt32 = 0
            memcpy(&naluLen, ptr + offset, 4)
            naluLen = naluLen.bigEndian
            offset += 4
            guard naluLen > 0, offset + Int(naluLen) <= length else { break }
            let nalu = Data(bytes: ptr + offset, count: Int(naluLen))
            offset += Int(naluLen)
            onNALU?(nalu, isKey)
        }
    }

    private func extractSPSPPS(_ sb: CMSampleBuffer) {
        guard let fmt = CMSampleBufferGetFormatDescription(sb) else { return }
        var spsPtr: UnsafePointer<UInt8>?; var spsSize = 0
        var ppsPtr: UnsafePointer<UInt8>?; var ppsSize = 0
        CMVideoFormatDescriptionGetH264ParameterSetAtIndex(fmt, parameterSetIndex: 0, parameterSetPointerOut: &spsPtr, parameterSetSizeOut: &spsSize, parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil)
        CMVideoFormatDescriptionGetH264ParameterSetAtIndex(fmt, parameterSetIndex: 1, parameterSetPointerOut: &ppsPtr, parameterSetSizeOut: &ppsSize, parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil)
        guard let sp = spsPtr, let pp = ppsPtr else { return }
        sps = Data(bytes: sp, count: spsSize)
        pps = Data(bytes: pp, count: ppsSize)
        print("[Encoder] SPS(\(spsSize)) PPS(\(ppsSize))")
        onSPSPPS?(sps!, pps!)
    }
}

// MARK: - Screen Capture

class SimulatorCapture: NSObject, SCStreamDelegate, SCStreamOutput {
    var stream: SCStream?
    var encoder: H264Encoder?
    var muxer: FMP4Muxer?
    var ws: WSClient
    var timestamp: UInt64 = 0
    let frameDuration: UInt64

    init(ws: WSClient, fps: Int) {
        self.ws = ws
        self.frameDuration = 90000 / UInt64(fps)
        super.init()
    }

    func start() async throws {
        let content = try await SCShareableContent.current
        // 找到最大的 Simulator 窗口（clone 的窗口也会被找到）
        let simWindows = content.windows.filter {
            $0.owningApplication?.bundleIdentifier == "com.apple.iphonesimulator" && $0.frame.height > 100
        }.sorted { $0.frame.height > $1.frame.height }

        guard let window = simWindows.first else {
            print("[Capture] ERROR: No Simulator window found. Is Simulator running?")
            return
        }

        print("[Capture] Found Simulator window: \(window.title ?? "untitled") (\(Int(window.frame.width))x\(Int(window.frame.height)))")

        // Simulator 标题栏高度（点数）
        let titleBarHeight: CGFloat = 52
        let contentHeight = window.frame.height - titleBarHeight
        let contentWidth = window.frame.width

        print("[Capture] Window: \(Int(window.frame.width))x\(Int(window.frame.height)), titleBar: \(Int(titleBarHeight)), content: \(Int(contentWidth))x\(Int(contentHeight))")

        let filter = SCContentFilter(desktopIndependentWindow: window)
        let config = SCStreamConfiguration()
        config.width = Int(contentWidth) * 2  // Retina
        config.height = Int(contentHeight) * 2
        // 裁剪掉标题栏（sourceRect 是点坐标，原点在左上角）
        config.sourceRect = CGRect(x: 0, y: titleBarHeight, width: contentWidth, height: contentHeight)
        config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(targetFPS))
        config.showsCursor = false
        config.pixelFormat = kCVPixelFormatType_32BGRA

        stream = SCStream(filter: filter, configuration: config, delegate: self)
        try stream?.addStreamOutput(self, type: .screen, sampleHandlerQueue: .global(qos: .userInteractive))
        try await stream?.startCapture()
        print("[Capture] Started capturing at \(config.width)x\(config.height) @ \(targetFPS)fps")
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen else { return }
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sb) else { return }

        if encoder == nil {
            let w = CVPixelBufferGetWidth(pixelBuffer)
            let h = CVPixelBufferGetHeight(pixelBuffer)
            encoder = H264Encoder(width: w, height: h, fps: targetFPS, bitrate: bitrate)
            encoder?.onSPSPPS = { [weak self] sps, pps in
                guard let self = self else { return }
                let w = CVPixelBufferGetWidth(pixelBuffer)
                let h = CVPixelBufferGetHeight(pixelBuffer)
                self.muxer = FMP4Muxer(sps: sps, pps: pps, width: w, height: h)
                let initSeg = self.muxer!.generateInitSegment()
                print("[Capture] Sending init segment (\(initSeg.count) bytes)")
                self.ws.sendBinary(initSeg)
            }
            encoder?.onNALU = { [weak self] nalu, isKey in
                guard let self = self, let muxer = self.muxer else { return }
                let segment = muxer.muxNALUnit(nalu, isKey: isKey, ts: self.timestamp, dur: self.frameDuration)
                self.timestamp += self.frameDuration
                self.ws.sendBinary(segment)
            }
        }

        let pts = CMSampleBufferGetPresentationTimeStamp(sb)
        encoder?.encode(pixelBuffer, pts: pts)
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        print("[Capture] Stopped: \(error.localizedDescription)")
    }
}

// MARK: - Main

// Initialize AppKit (required for ScreenCaptureKit in CLI)
let app = NSApplication.shared
app.setActivationPolicy(.accessory)

let wsClient = WSClient(url: URL(string: serverURL)!)
wsClient.connect()

print("[Capture] Waiting for WebSocket connection...")
while !wsClient.connected {
    Thread.sleep(forTimeInterval: 0.1)
}

let capture = SimulatorCapture(ws: wsClient, fps: targetFPS)

// Handle server messages (e.g. request_keyframe)
wsClient.onMessage = { jsonStr in
    if let data = jsonStr.data(using: .utf8),
       let msg = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
       let type = msg["type"] as? String {
        if type == "request_keyframe" {
            capture.encoder?.forceKeyframe()
        }
    }
}
Task {
    do {
        try await capture.start()
    } catch {
        print("[Capture] Failed to start: \(error)")
        exit(1)
    }
}

app.run()
