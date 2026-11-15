import AVFoundation
import NaturalLanguage
import Observation

/// "Listen": reads the archived text aloud and reports which word is being spoken.
@MainActor @Observable final class SpeechController: NSObject, AVSpeechSynthesizerDelegate {
    enum State { case idle, playing, paused }

    private(set) var state: State = .idle
    private(set) var rate: Double = 1
    /// The spoken word, in the reader's coordinates.
    private(set) var spoken: NSRange?

    @ObservationIgnored private let synth = AVSpeechSynthesizer()
    @ObservationIgnored private var text: NSString = ""
    @ObservationIgnored private var offset = 0
    @ObservationIgnored private var start = 0
    @ObservationIgnored private var lastLocation = 0
    @ObservationIgnored private var language: String?

    static let rates: [Double] = [1, 1.25, 1.5, 1.75, 2, 0.85]

    override init() {
        super.init()
        synth.delegate = self
    }

    func play(text: String, offset: Int) {
        switch state {
        case .playing:
            synth.pauseSpeaking(at: .word)
            state = .paused
        case .paused:
            synth.continueSpeaking()
            state = .playing
        case .idle:
            self.text = text as NSString
            self.offset = offset
            let recognizer = NLLanguageRecognizer()
            recognizer.processString(String(text.prefix(1200)))
            language = recognizer.dominantLanguage?.rawValue
            speak(from: 0)
        }
    }

    func stop() {
        guard state != .idle else { return }
        synth.stopSpeaking(at: .immediate)
        state = .idle
        spoken = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    func cycleRate() {
        rate = Self.rates[((Self.rates.firstIndex(of: rate) ?? 0) + 1) % Self.rates.count]
        if state == .playing {
            synth.stopSpeaking(at: .immediate)
            speak(from: lastLocation)
        }
    }

    private func speak(from location: Int) {
        guard location < text.length else { stop(); return }
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio)
        try? AVAudioSession.sharedInstance().setActive(true)
        start = location
        let utterance = AVSpeechUtterance(string: text.substring(from: location))
        utterance.rate = Float(AVSpeechUtteranceDefaultSpeechRate + Float(rate - 1) * 0.15)
        if let language, let voice = AVSpeechSynthesisVoice(language: language) { utterance.voice = voice }
        state = .playing
        synth.speak(utterance)
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, willSpeakRangeOfSpeechString characterRange: NSRange, utterance: AVSpeechUtterance) {
        Task { @MainActor in
            guard self.state != .idle else { return }
            self.lastLocation = self.start + characterRange.location
            self.spoken = NSRange(location: self.offset + self.start + characterRange.location, length: characterRange.length)
        }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor in
            // A rate change cancels the old utterance and starts a new one; only a real finish ends listening.
            guard !self.synth.isSpeaking else { return }
            self.state = .idle
            self.spoken = nil
        }
    }
}
