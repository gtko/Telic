fn main() {
    println!("cargo:rerun-if-env-changed=TELIC_APP_URL");
    println!("cargo:rerun-if-env-changed=TELIC_API_URL");
    tauri_build::build()
}
