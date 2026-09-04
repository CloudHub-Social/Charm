fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("ios") {
        cc::Build::new()
            .cpp(true)
            .file("src/matrix/ios_backup.mm")
            .flag_if_supported("-fobjc-arc")
            .compile("charm_ios_backup");
        println!("cargo:rustc-link-lib=framework=Foundation");
    }

    tauri_build::build()
}
