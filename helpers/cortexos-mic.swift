import AVFoundation
import CoreAudio
import Darwin

// MARK: - Output format constants
let sampleRate: Double = 16000
let channels: AVAudioChannelCount = 1
let bitDepth: UInt32 = 16

// MARK: - Globals for signal handler access
var engine: AVAudioEngine?
var isRunning = true

// MARK: - Signal handling for clean shutdown
func installSignalHandlers() {
    let handler: @convention(c) (Int32) -> Void = { signal in
        FileHandle.standardError.write(
            Data("\n[cortexos-mic] Received signal \(signal), shutting down...\n".utf8)
        )
        isRunning = false
        engine?.stop()
        exit(0)
    }
    signal(SIGINT, handler)
    signal(SIGTERM, handler)
}

// MARK: - VPIO fallback for macOS < 14
/// Attempts to set kAudioUnitSubType_VoiceProcessingIO on the input node's
/// underlying AudioUnit for systems that lack `isVoiceProcessingEnabled`.
func enableVPIOLegacy(on inputNode: AVAudioInputNode) -> Bool {
    // Get the AudioUnit from the input node
    let audioUnit = inputNode.audioUnit!

    var enableFlag: UInt32 = 1
    let status = AudioUnitSetProperty(
        audioUnit,
        kAudioOutputUnitProperty_EnableIO,
        kAudioUnitScope_Input,
        1, // input bus
        &enableFlag,
        UInt32(MemoryLayout<UInt32>.size)
    )

    if status != noErr {
        FileHandle.standardError.write(
            Data("[cortexos-mic] Warning: Legacy VPIO setup returned status \(status)\n".utf8)
        )
        return false
    }
    return true
}

// MARK: - Main
func main() {
    installSignalHandlers()

    let audioEngine = AVAudioEngine()
    engine = audioEngine

    let inputNode = audioEngine.inputNode

    // Enable Voice Processing IO (hardware AEC)
    var vpioEnabled = false

    if #available(macOS 14.0, *) {
        do {
            try inputNode.setVoiceProcessingEnabled(true)
            vpioEnabled = true
        } catch {
            FileHandle.standardError.write(
                Data("[cortexos-mic] macOS 14+ VPIO failed: \(error). Trying legacy path...\n".utf8)
            )
        }
    }

    if !vpioEnabled {
        vpioEnabled = enableVPIOLegacy(on: inputNode)
    }

    if !vpioEnabled {
        FileHandle.standardError.write(
            Data("[cortexos-mic] Warning: Could not enable VPIO. AEC may not be active.\n".utf8)
        )
    }

    // Define the target output format: 16kHz, mono, signed 16-bit integer
    guard let outputFormat = AVAudioFormat(
        commonFormat: .pcmFormatInt16,
        sampleRate: sampleRate,
        channels: channels,
        interleaved: true
    ) else {
        FileHandle.standardError.write(
            Data("[cortexos-mic] Error: Could not create output audio format.\n".utf8)
        )
        exit(1)
    }

    // The input node's native hardware format
    let inputFormat = inputNode.outputFormat(forBus: 0)

    // Create a format converter from native -> 16kHz/mono/Int16
    guard let converter = AVAudioConverter(from: inputFormat, to: outputFormat) else {
        FileHandle.standardError.write(
            Data("[cortexos-mic] Error: Could not create audio converter from \(inputFormat) to \(outputFormat).\n".utf8)
        )
        exit(1)
    }
    converter.sampleRateConverterQuality = .max

    // Tap buffer size in frames (at input sample rate).
    // ~100ms of audio at the native rate keeps latency low.
    let tapBufferSize: AVAudioFrameCount = AVAudioFrameCount(inputFormat.sampleRate * 0.1)

    // Install a tap on the input node
    inputNode.installTap(onBus: 0, bufferSize: tapBufferSize, format: inputFormat) { (buffer, _) in
        // Calculate how many output frames correspond to this input buffer
        let ratio = sampleRate / inputFormat.sampleRate
        let outputFrameCapacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 1

        guard let outputBuffer = AVAudioPCMBuffer(
            pcmFormat: outputFormat,
            frameCapacity: outputFrameCapacity
        ) else {
            return
        }

        var error: NSError?
        let status = converter.convert(to: outputBuffer, error: &error) { inNumPackets, outStatus in
            outStatus.pointee = .haveData
            return buffer
        }

        if let error = error {
            FileHandle.standardError.write(
                Data("[cortexos-mic] Conversion error: \(error)\n".utf8)
            )
            return
        }

        guard status != .error, outputBuffer.frameLength > 0 else {
            return
        }

        // Write raw PCM bytes to stdout
        let byteCount = Int(outputBuffer.frameLength) * Int(bitDepth / 8) * Int(channels)
        if let channelData = outputBuffer.int16ChannelData {
            let data = Data(bytes: channelData[0], count: byteCount)
            FileHandle.standardOutput.write(data)
        }
    }

    // Start the engine
    do {
        try audioEngine.start()
    } catch {
        FileHandle.standardError.write(
            Data("[cortexos-mic] Error starting audio engine: \(error)\n".utf8)
        )
        exit(1)
    }

    FileHandle.standardError.write(
        Data("[cortexos-mic] VPIO active \u{2014} hardware AEC enabled\n".utf8)
    )
    FileHandle.standardError.write(
        Data("[cortexos-mic] Format: \(Int(sampleRate))Hz, \(channels)ch, \(bitDepth)-bit signed PCM\n".utf8)
    )
    FileHandle.standardError.write(
        Data("[cortexos-mic] Streaming raw PCM to stdout. Ctrl+C to stop.\n".utf8)
    )

    // Keep the process alive
    RunLoop.current.run()
}

main()
