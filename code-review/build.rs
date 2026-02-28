use std::env;
use std::path::PathBuf;
use std::process::Command;

fn main() {
    println!("cargo::rerun-if-changed=ui/src/");
    println!("cargo::rerun-if-changed=ui/Cargo.toml");
    println!("cargo::rerun-if-changed=assets/");

    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());
    let wasm_target_dir = out_dir.join("wasm-target");
    let wasm_dist_dir = out_dir.join("wasm-dist");

    // Step 1: Build the UI crate for wasm32
    let status = Command::new("cargo")
        .args([
            "build",
            "--release",
            "--target",
            "wasm32-unknown-unknown",
            "--manifest-path",
            "ui/Cargo.toml",
            "--target-dir",
        ])
        .arg(&wasm_target_dir)
        .status()
        .expect("Failed to run cargo build for WASM. Is the wasm32-unknown-unknown target installed? Run: rustup target add wasm32-unknown-unknown");

    assert!(
        status.success(),
        "WASM build failed. Check ui/ crate for errors."
    );

    // Step 2: Run wasm-bindgen
    let wasm_file = wasm_target_dir
        .join("wasm32-unknown-unknown")
        .join("release")
        .join("code_review_ui.wasm");

    assert!(
        wasm_file.exists(),
        "Expected WASM file not found at {wasm_file:?}. Build may have failed."
    );

    let status = Command::new("wasm-bindgen")
        .args(["--target", "web", "--no-typescript", "--out-dir"])
        .arg(&wasm_dist_dir)
        .arg(&wasm_file)
        .status()
        .expect("Failed to run wasm-bindgen. Is it installed? Run: cargo install wasm-bindgen-cli");

    assert!(status.success(), "wasm-bindgen failed.");

    // Step 3: Emit paths as env vars for the server to embed
    let js_path = wasm_dist_dir.join("code_review_ui.js");
    let wasm_bg_path = wasm_dist_dir.join("code_review_ui_bg.wasm");

    assert!(js_path.exists(), "JS glue not found at {js_path:?}");
    assert!(wasm_bg_path.exists(), "WASM bg not found at {wasm_bg_path:?}");

    println!("cargo::rustc-env=WASM_JS_PATH={}", js_path.display());
    println!("cargo::rustc-env=WASM_BG_PATH={}", wasm_bg_path.display());
}
