use std::process::Command;

fn git(args: &[&str]) -> Option<String> {
    let output = Command::new("git").args(args).output().ok()?;
    output.status.success().then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
}
fn main() {
    println!("cargo:rerun-if-changed=src");
    if let Some(head) = git(&["rev-parse", "HEAD"]) {
        println!("cargo:rustc-env=WINDOWSTASH_BUILD_ID={head}");
    }
    for reference in [Some("HEAD".to_string()), git(&["symbolic-ref", "-q", "HEAD"])] {
        if let Some(path) = reference.and_then(|name| git(&["rev-parse", "--git-path", &name])) {
            println!("cargo:rerun-if-changed={path}");
        }
    }
}
