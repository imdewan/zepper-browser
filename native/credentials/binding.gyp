{
  "targets": [
    {
      "target_name": "zepper_credentials",
      "sources": ["passkeys.mm", "system.mm", "ble.mm"],
      "xcode_settings": {
        "CLANG_ENABLE_OBJC_ARC": "YES",
        "MACOSX_DEPLOYMENT_TARGET": "14.0",
        "OTHER_CPLUSPLUSFLAGS": ["-std=c++17", "-fobjc-arc"]
      },
      "link_settings": {
        "libraries": [
          "-framework AuthenticationServices",
          "-framework AppKit",
          "-framework Foundation",
          "-framework Security",
          "-framework LocalAuthentication",
          "-framework CoreBluetooth"
        ]
      }
    }
  ]
}
