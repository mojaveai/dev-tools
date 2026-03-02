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

    // Step 1: Build the UI crate for wasm32, optimized for size.
    // Environment overrides keep these settings isolated to the WASM build
    // without affecting the host-target release profile.
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
        .env("CARGO_PROFILE_RELEASE_OPT_LEVEL", "z")
        .env("CARGO_PROFILE_RELEASE_LTO", "true")
        .env("CARGO_PROFILE_RELEASE_CODEGEN_UNITS", "1")
        .env("CARGO_PROFILE_RELEASE_STRIP", "true")
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

    // Step 3: Shrink the WASM binary with wasm-opt (best-effort).
    // Uses a temp file because wasm-opt cannot read and write the same path.
    let wasm_bg_path = wasm_dist_dir.join("code_review_ui_bg.wasm");
    let wasm_opt_tmp = wasm_dist_dir.join("code_review_ui_bg.opt.wasm");
    match Command::new("wasm-opt")
        .arg("-Oz")
        .arg("--enable-bulk-memory")
        .arg("--enable-sign-ext")
        .arg("--enable-mutable-globals")
        .arg("--enable-nontrapping-float-to-int")
        .arg("--output")
        .arg(&wasm_opt_tmp)
        .arg(&wasm_bg_path)
        .status()
    {
        Ok(s) if s.success() => {
            std::fs::rename(&wasm_opt_tmp, &wasm_bg_path)
                .expect("Failed to rename wasm-opt output");
            println!("cargo::warning=wasm-opt applied successfully");
        }
        Ok(_) => {
            // Clean up temp file on failure
            let _ = std::fs::remove_file(&wasm_opt_tmp);
            println!("cargo::warning=wasm-opt failed; skipping (binary will be larger)");
        }
        Err(_) => {
            println!(
                "cargo::warning=wasm-opt not found; skipping. \
                 Install for smaller WASM: cargo install wasm-opt"
            );
        }
    }

    // Step 4: Emit paths as env vars for the server to embed
    let js_path = wasm_dist_dir.join("code_review_ui.js");

    assert!(js_path.exists(), "JS glue not found at {js_path:?}");
    assert!(
        wasm_bg_path.exists(),
        "WASM bg not found at {wasm_bg_path:?}"
    );

    println!("cargo::rustc-env=WASM_JS_PATH={}", js_path.display());
    println!("cargo::rustc-env=WASM_BG_PATH={}", wasm_bg_path.display());
}
