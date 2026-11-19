import SwiftUI

@main
struct AutoEditApp: App {
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(model)
                .frame(minWidth: 1120, minHeight: 760)
        }
        .windowStyle(.titleBar)
        .commands {
            CommandGroup(replacing: .newItem) {}
        }

        Settings {
            AppSettingsView()
                .environmentObject(model)
        }
    }
}

private struct AppSettingsView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        Form {
            Picker("语言 / Language", selection: $model.language) {
                Text(L.text("Follow System")).tag("system")
                Text("简体中文").tag("zh-Hans")
                Text("English").tag("en")
            }
        }
        .formStyle(.grouped)
        .frame(width: 420, height: 120)
    }
}
