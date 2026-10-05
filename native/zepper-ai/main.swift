// zepper-ai: Zepper's on-device intelligence. Everything runs on the Mac; nothing is sent anywhere.
//
//   zepper-ai --check   prints what's available, e.g. {"ai": true, "translation": true, "embeddings": true}
//   zepper-ai           serves requests: one JSON object per line on stdin, {"id": 1, "op": "...", ...},
//                       answered on stdout with {"id": 1, "result": {...}} or {"id": 1, "error": "..."}.
//                       Streaming answers send {"id": 1, "partial": "text so far"} first.
//
// Operations:
//   tidy       {tabs: [{title, host}]}                       → {groups: [{name, tabs: [index]}]}
//   summarize  {title, text}                                  → streams, then {text}
//   ask        {title, text, question, history: [[q, a]]}     → streams, then {text}
//   embed      {texts: [string]}                              → {model, vectors: [base64 Float32 | null]}
//   rank       {query, items: [{title, host, text}]}          → {order: [index]}
//   detect     {text}                                         → {language}
//   translate  {from?, to, texts: [string]}                   → {from, translations: [string]}
import Foundation
import FoundationModels
import NaturalLanguage
import Translation

// MARK: - Output

/// Writes one JSON object per line; requests run concurrently, so writes are serialised.
final class Output: @unchecked Sendable {
    private let lock = NSLock()

    func send(_ object: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
        lock.lock()
        defer { lock.unlock() }
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([0x0A]))
    }
}

let output = Output()

struct Failure: Error {
    let message: String
    let code: String?
    init(_ message: String, code: String? = nil) {
        self.message = message
        self.code = code
    }
}

// MARK: - Availability

func unavailableReason() -> String? {
    switch SystemLanguageModel.default.availability {
    case .available: return nil
    case .unavailable(.deviceNotEligible): return "This Mac doesn't support Apple Intelligence."
    case .unavailable(.appleIntelligenceNotEnabled): return "Apple Intelligence is turned off in System Settings."
    case .unavailable(.modelNotReady): return "Apple Intelligence is still getting ready."
    case .unavailable(_): return "Apple Intelligence isn't available."
    }
}

func check() -> [String: Any] {
    var result: [String: Any] = ["ai": unavailableReason() == nil, "embeddings": Embedder.shared.available]
    if let reason = unavailableReason() { result["reason"] = reason }
    if #available(macOS 26.4, *) { result["translation"] = true } else { result["translation"] = false }
    return result
}

// MARK: - Text

/// The model's context is small (about 4,000 tokens), so pages are cut to fit. Scripts like
/// Chinese or Japanese use far more tokens per character than Latin ones.
func characterBudget(for text: String) -> Int {
    let sample = text.prefix(2000)
    let latin = sample.unicodeScalars.filter { $0.value < 0x0250 }.count
    return Double(latin) / Double(max(sample.unicodeScalars.count, 1)) > 0.8 ? 7000 : 2400
}

/// Splits text into passages of about `size` characters, on paragraph and sentence boundaries.
func passages(_ text: String, size: Int) -> [String] {
    var result: [String] = []
    var current = ""
    for paragraph in text.components(separatedBy: "\n") where !paragraph.trimmingCharacters(in: .whitespaces).isEmpty {
        let pieces = paragraph.count > size ? sentences(paragraph) : [paragraph]
        for piece in pieces {
            if current.count + piece.count > size, !current.isEmpty {
                result.append(current)
                current = ""
            }
            current += (current.isEmpty ? "" : "\n") + piece.prefix(size)
        }
    }
    if !current.isEmpty { result.append(current) }
    return result
}

func sentences(_ text: String) -> [String] {
    let tokenizer = NLTokenizer(unit: .sentence)
    tokenizer.string = text
    return tokenizer.tokens(for: text.startIndex..<text.endIndex).map { String(text[$0]) }
}

func describe(_ error: Error) -> Failure {
    if let failure = error as? Failure { return failure }
    if let generation = error as? LanguageModelSession.GenerationError {
        switch generation {
        case .guardrailViolation: return Failure("Apple Intelligence can't help with this page.", code: "guardrail")
        case .exceededContextWindowSize: return Failure("This page is too long for Apple Intelligence.", code: "tooLong")
        case .unsupportedLanguageOrLocale: return Failure("Apple Intelligence doesn't support this page's language yet.", code: "language")
        case .assetsUnavailable: return Failure("Apple Intelligence is still getting ready.", code: "notReady")
        default: break
        }
    }
    return Failure(error.localizedDescription)
}

// MARK: - Embeddings

/// Sentence vectors from Apple's contextual embedding model (mean of its token vectors).
final class Embedder: @unchecked Sendable {
    static let shared = Embedder()
    private let lock = NSLock()
    private var model: NLContextualEmbedding?
    private var loaded = false

    private func prepare() -> NLContextualEmbedding? {
        if loaded { return model }
        loaded = true
        guard let candidate = NLContextualEmbedding(script: .latin) else { return nil }
        if !candidate.hasAvailableAssets {
            // Download for next time.
            candidate.requestAssets { _, _ in }
            return nil
        }
        do {
            try candidate.load()
            model = candidate
        } catch {
            model = nil
        }
        return model
    }

    var available: Bool {
        lock.lock()
        defer { lock.unlock() }
        return prepare() != nil
    }

    var identifier: String {
        lock.lock()
        defer { lock.unlock() }
        return prepare()?.modelIdentifier ?? ""
    }

    func vector(_ text: String) -> [Float]? {
        lock.lock()
        defer { lock.unlock() }
        guard let model = prepare() else { return nil }
        let input = String(text.prefix(1200))
        guard !input.isEmpty, let result = try? model.embeddingResult(for: input, language: nil) else { return nil }
        var sum = [Float](repeating: 0, count: model.dimension)
        var count: Float = 0
        result.enumerateTokenVectors(in: input.startIndex..<input.endIndex) { vector, _ in
            for i in 0..<min(vector.count, sum.count) { sum[i] += Float(vector[i]) }
            count += 1
            return true
        }
        return count > 0 ? sum.map { $0 / count } : nil
    }
}

func cosine(_ a: [Float], _ b: [Float]) -> Float {
    var dot: Float = 0, na: Float = 0, nb: Float = 0
    for i in 0..<min(a.count, b.count) {
        dot += a[i] * b[i]
        na += a[i] * a[i]
        nb += b[i] * b[i]
    }
    return dot / max((na * nb).squareRoot(), 1e-6)
}

// MARK: - Generable answers

@Generable
struct Tidy {
    @Guide(description: "Groups of related tabs. Each group has at least two tabs. Leave out tabs that don't belong with any other.")
    var groups: [Group]
}

@Generable
struct Group {
    @Guide(description: "A short folder name for the group: one to three words, Title Case, no emoji")
    var name: String
    @Guide(description: "The numbers of the tabs in this group, from the list")
    var tabs: [Int]
}

@Generable
struct Matches {
    @Guide(description: "The numbers of the pages that match what the person is looking for, best match first. Leave out pages that don't match.")
    var pages: [Int]
}

// MARK: - Operations

func requireModel() throws {
    if let reason = unavailableReason() { throw Failure(reason, code: "unavailable") }
}

func tidy(_ body: [String: Any]) async throws -> [String: Any] {
    try requireModel()
    let tabs = (body["tabs"] as? [[String: Any]]) ?? []
    guard tabs.count >= 2 else { return ["groups": []] }
    let list = tabs.enumerated()
        .map { "\($0.offset). \(String(describing: $0.element["title"] ?? "").prefix(90)) (\($0.element["host"] ?? ""))" }
        .joined(separator: "\n")
    let session = LanguageModelSession(instructions: """
        You organise someone's open browser tabs into folders. Put tabs about the same topic, \
        task or project together. Prefer a few meaningful groups over many small ones. \
        Name each folder for what the tabs have in common.
        """)
    let response = try await session.respond(to: "Tabs:\n\(list)", generating: Tidy.self)
    let groups = response.content.groups.map { group -> [String: Any] in
        ["name": group.name, "tabs": Array(Set(group.tabs.filter { $0 >= 0 && $0 < tabs.count })).sorted()]
    }
    return ["groups": groups]
}

/// Streams a response, sending the text so far as it grows.
func stream(_ id: Int, session: LanguageModelSession, prompt: String) async throws -> String {
    var text = ""
    var lastSent = Date.distantPast
    for try await snapshot in session.streamResponse(to: prompt) {
        text = snapshot.content
        if Date().timeIntervalSince(lastSent) > 0.05 {
            output.send(["id": id, "partial": text])
            lastSent = Date()
        }
    }
    return text
}

func summarize(_ id: Int, _ body: [String: Any]) async throws -> [String: Any] {
    try requireModel()
    let title = body["title"] as? String ?? ""
    let text = body["text"] as? String ?? ""
    guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw Failure("There's no text on this page to summarise.", code: "empty") }
    // One streamed pass over as much of the page as fits: pages put their main points first, and
    // answering at once beats a slower, more complete summary.
    let material = String(text.prefix(characterBudget(for: text)))
    let session = LanguageModelSession(instructions: """
        You summarise web pages for someone deciding whether to read them. Reply with three to six \
        short bullet points, each starting with "• ". Cover the main points, with numbers, dates and \
        names where the page gives them. Never mention what the page doesn't say. Write in the page's \
        language. No introduction or conclusion.
        """)
    let summary = try await stream(id, session: session, prompt: "Page title: \(title)\n\n\(material)")
    return ["text": summary]
}

func ask(_ id: Int, _ body: [String: Any]) async throws -> [String: Any] {
    try requireModel()
    let title = body["title"] as? String ?? ""
    let text = body["text"] as? String ?? ""
    let question = body["question"] as? String ?? ""
    let history = (body["history"] as? [[String]]) ?? []
    guard !question.isEmpty else { throw Failure("Ask a question about the page.") }
    let budget = characterBudget(for: text) - 1200
    var excerpts = String(text.prefix(budget))
    if text.count > budget {
        // Only the passages most related to the question fit.
        let parts = passages(text, size: 700)
        let query = Embedder.shared.vector(question + " " + (history.last?.first ?? ""))
        let words = Set(question.lowercased().split { !$0.isLetter && !$0.isNumber }.filter { $0.count > 2 })
        let scored = parts.enumerated().map { index, part -> (Int, Float) in
            let semantic = query.flatMap { q in Embedder.shared.vector(part).map { cosine(q, $0) } } ?? 0
            let lower = part.lowercased()
            let keyword = Float(words.filter { lower.contains($0) }.count) / Float(max(words.count, 1))
            return (index, semantic + keyword * 0.5)
        }
        var chosen: [Int] = []
        var used = 0
        for (index, _) in scored.sorted(by: { $0.1 > $1.1 }) where used + parts[index].count <= budget {
            chosen.append(index)
            used += parts[index].count
        }
        excerpts = chosen.sorted().map { parts[$0] }.joined(separator: "\n…\n")
    }
    let earlier = history.suffix(2).map { "Q: \($0.first ?? "")\nA: \($0.last ?? "")" }.joined(separator: "\n")
    let session = LanguageModelSession(instructions: """
        You answer questions about the web page someone is reading, using only the page excerpts \
        provided. Be brief: a sentence, or a few short bullet points starting with "• ". If the \
        excerpts don't answer the question, say the page doesn't say. Answer in the question's language.
        """)
    let prompt = "Page title: \(title)\n\nPage excerpts:\n\(excerpts)\n\n\(earlier.isEmpty ? "" : "Earlier:\n\(earlier)\n\n")Question: \(question)"
    let answer = try await stream(id, session: session, prompt: prompt)
    return ["text": answer]
}

/// Vectors go back as base64 little-endian Float32 arrays (compact, and exact).
func embed(_ body: [String: Any]) -> [String: Any] {
    let texts = (body["texts"] as? [String]) ?? []
    let vectors: [Any] = texts.map { text in
        guard let vector = Embedder.shared.vector(text) else { return NSNull() }
        return vector.withUnsafeBufferPointer { Data(buffer: $0) }.base64EncodedString()
    }
    return ["model": Embedder.shared.identifier, "vectors": vectors]
}

func rank(_ body: [String: Any]) async throws -> [String: Any] {
    try requireModel()
    let query = body["query"] as? String ?? ""
    let items = (body["items"] as? [[String: Any]]) ?? []
    guard !items.isEmpty else { return ["order": []] }
    let list = items.enumerated().map { index, item in
        let snippet = String(String(describing: item["text"] ?? "").prefix(160))
        return "\(index). \(String(describing: item["title"] ?? "").prefix(100)) (\(item["host"] ?? ""))\(snippet.isEmpty ? "" : " — \(snippet)")"
    }.joined(separator: "\n")
    let session = LanguageModelSession(instructions: """
        You help someone find a page in their browsing history. Given what they remember and a list \
        of pages they visited, pick the pages that match, best first.
        """)
    let response = try await session.respond(to: "They're looking for: \(query)\n\nPages:\n\(list)", generating: Matches.self)
    var seen = Set<Int>()
    return ["order": response.content.pages.filter { $0 >= 0 && $0 < items.count && seen.insert($0).inserted }]
}

func detect(_ body: [String: Any]) -> [String: Any] {
    let recognizer = NLLanguageRecognizer()
    recognizer.processString(String((body["text"] as? String ?? "").prefix(2000)))
    return ["language": recognizer.dominantLanguage?.rawValue ?? ""]
}

func translate(_ body: [String: Any]) async throws -> [String: Any] {
    guard #available(macOS 26.4, *) else { throw Failure("Translating pages needs macOS 26.4 or later.", code: "unsupported") }
    let texts = (body["texts"] as? [String]) ?? []
    guard let to = body["to"] as? String, !texts.isEmpty else { return ["translations": texts] }
    var from = body["from"] as? String ?? ""
    if from.isEmpty {
        from = detect(["text": texts.joined(separator: "\n")])["language"] as? String ?? ""
    }
    guard !from.isEmpty else { throw Failure("Couldn't tell which language this page is in.", code: "unknownLanguage") }
    let source = Locale.Language(identifier: from)
    let target = Locale.Language(identifier: to)
    switch await LanguageAvailability().status(from: source, to: target) {
    case .unsupported: throw Failure("Translating from this language isn't supported.", code: "unsupported")
    case .supported: throw Failure("The languages for this translation aren't downloaded yet.", code: "notInstalled")
    default: break
    }
    let session = TranslationSession(installedSource: source, target: target)
    let requests = texts.enumerated().map { TranslationSession.Request(sourceText: $0.element, clientIdentifier: String($0.offset)) }
    let responses = try await session.translations(from: requests)
    var translations = texts
    for response in responses {
        if let index = response.clientIdentifier.flatMap(Int.init), index < translations.count { translations[index] = response.targetText }
    }
    return ["from": from, "translations": translations]
}

func handle(id: Int, op: String, body: [String: Any]) async {
    do {
        let result: [String: Any]
        switch op {
        case "check": result = check()
        case "tidy": result = try await tidy(body)
        case "summarize": result = try await summarize(id, body)
        case "ask": result = try await ask(id, body)
        case "embed": result = embed(body)
        case "rank": result = try await rank(body)
        case "detect": result = detect(body)
        case "translate": result = try await translate(body)
        default: throw Failure("Unknown operation \(op)")
        }
        output.send(["id": id, "result": result])
    } catch {
        let failure = describe(error)
        var message: [String: Any] = ["id": id, "error": failure.message]
        if let code = failure.code { message["code"] = code }
        output.send(message)
    }
}

@main
struct Main {
    static func main() async {
        if CommandLine.arguments.contains("--check") {
            output.send(check())
            return
        }
        await withTaskGroup(of: Void.self) { group in
            do {
                for try await line in FileHandle.standardInput.bytes.lines {
                    guard let data = line.data(using: .utf8),
                          let request = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                          let id = request["id"] as? Int,
                          let op = request["op"] as? String
                    else { continue }
                    group.addTask { await handle(id: id, op: op, body: request) }
                }
            } catch {
                // stdin closed: finish what's running, then exit.
            }
        }
    }
}
