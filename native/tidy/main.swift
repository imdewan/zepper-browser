// zepper-tidy: groups browser tabs with Apple Intelligence's on-device model.
//
//   zepper-tidy --check       prints {"available": true} or {"available": false, "reason": "..."}
//   zepper-tidy < tabs.json   reads {"tabs": [{"title": "...", "host": "..."}]} and prints
//                             {"groups": [{"name": "...", "tabs": [0, 2, 5]}]} (indexes into the input)
//
// Everything runs on the Mac; nothing is sent anywhere.
import Foundation
import FoundationModels

struct Input: Decodable {
    struct Tab: Decodable {
        let title: String
        let host: String
    }
    let tabs: [Tab]
}

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

func emit(_ object: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: object)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

func unavailableReason() -> String? {
    switch SystemLanguageModel.default.availability {
    case .available: return nil
    case .unavailable(.deviceNotEligible): return "This Mac doesn't support Apple Intelligence."
    case .unavailable(.appleIntelligenceNotEnabled): return "Apple Intelligence is turned off in System Settings."
    case .unavailable(.modelNotReady): return "Apple Intelligence is still getting ready."
    case .unavailable(_): return "Apple Intelligence isn't available."
    }
}

@main
struct Main {
    static func main() async {
        if CommandLine.arguments.contains("--check") {
            if let reason = unavailableReason() { emit(["available": false, "reason": reason]) } else { emit(["available": true]) }
            return
        }
        if let reason = unavailableReason() {
            emit(["error": reason])
            exit(2)
        }
        let raw = FileHandle.standardInput.readDataToEndOfFile()
        guard let input = try? JSONDecoder().decode(Input.self, from: raw), input.tabs.count >= 2 else {
            emit(["groups": []])
            return
        }
        let list = input.tabs.enumerated()
            .map { "\($0.offset). \($0.element.title.prefix(90)) (\($0.element.host))" }
            .joined(separator: "\n")
        let session = LanguageModelSession(instructions: """
            You organise someone's open browser tabs into folders. Put tabs about the same topic, \
            task or project together. Prefer a few meaningful groups over many small ones. \
            Name each folder for what the tabs have in common.
            """)
        do {
            let response = try await session.respond(to: "Tabs:\n\(list)", generating: Tidy.self)
            let groups = response.content.groups.map { group -> [String: Any] in
                let valid = Array(Set(group.tabs.filter { $0 >= 0 && $0 < input.tabs.count })).sorted()
                return ["name": group.name, "tabs": valid]
            }
            emit(["groups": groups])
        } catch {
            emit(["error": "Apple Intelligence couldn't tidy these tabs (\(error.localizedDescription))."])
            exit(1)
        }
    }
}
