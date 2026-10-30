//! `cargo install desk-pilot`: the MCP server as one command.
//!
//! The server is Node and its engine is C# compiled on first use, so this program only
//! carries them: it unpacks both into a per-version folder and hands stdio over to Node.

#[cfg(not(windows))]
compile_error!("desk-pilot is Windows only: it drives the Windows desktop.");

use std::env;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{self, Command};

const VERSION: &str = env!("CARGO_PKG_VERSION");
const MIN_NODE: (u32, u32) = (22, 19);
const SERVER: &[u8] = include_bytes!("../dist/server.mjs");
const ENGINE: &[(&str, &[u8])] = &[
    ("Actions.cs", include_bytes!("../engine/Actions.cs")),
    ("Capture.cs", include_bytes!("../engine/Capture.cs")),
    ("Input.cs", include_bytes!("../engine/Input.cs")),
    ("Native.cs", include_bytes!("../engine/Native.cs")),
    ("Overlay.cs", include_bytes!("../engine/Overlay.cs")),
    ("Program.cs", include_bytes!("../engine/Program.cs")),
    ("Uia.cs", include_bytes!("../engine/Uia.cs")),
    ("Windows.cs", include_bytes!("../engine/Windows.cs")),
];

const HELP: &str = "\
desk-pilot: an MCP server for the real Windows desktop (stdio).

Add it to an MCP client as the command `desk-pilot`, for example:
  claude mcp add desk-pilot -- desk-pilot

Options:
  -h, --help     Show this help
  -V, --version  Show the version

Needs Windows 10 2004 or later and Node 22.19 or later on PATH.";

/// Write a file only if its content differs. Two servers may start at once, so each writes
/// its own temporary file and renames it into place.
fn put(path: &Path, content: &[u8]) -> io::Result<()> {
    if fs::read(path).is_ok_and(|current| current == content) {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temp = path.with_extension(format!("{}.tmp", process::id()));
    fs::write(&temp, content)?;
    let moved = fs::rename(&temp, path);
    if moved.is_err() {
        let _ = fs::remove_file(&temp);
        if fs::read(path).is_ok_and(|current| current == content) {
            return Ok(());
        }
    }
    moved
}

/// Lay the server out as the plugin does: `dist/server.mjs` finds `engine/` beside it.
fn unpack(root: &Path) -> io::Result<PathBuf> {
    for (name, content) in ENGINE {
        put(&root.join("engine").join(name), content)?;
    }
    let server = root.join("dist").join("server.mjs");
    put(&server, SERVER)?;
    Ok(server)
}

/// `v24.16.0` to `(24, 16)`.
fn parse_node_version(text: &str) -> Option<(u32, u32)> {
    let mut parts = text.trim().strip_prefix('v')?.split('.');
    Some((parts.next()?.parse().ok()?, parts.next()?.parse().ok()?))
}

fn check_node() -> Result<(), String> {
    let needed = format!("Node {}.{} or later", MIN_NODE.0, MIN_NODE.1);
    let output = Command::new("node")
        .arg("--version")
        .output()
        .map_err(|error| format!("desk-pilot needs {needed} on PATH ({error}). Get it from https://nodejs.org"))?;
    let text = String::from_utf8_lossy(&output.stdout);
    match parse_node_version(&text) {
        Some(found) if found >= MIN_NODE => Ok(()),
        _ => Err(format!("desk-pilot needs {needed}; PATH has {}", text.trim())),
    }
}

fn run() -> Result<i32, String> {
    check_node()?;
    let base = env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .ok_or("LOCALAPPDATA is not set, so desk-pilot has nowhere to unpack")?
        .join("desk-pilot");
    let server = unpack(&base.join(VERSION)).map_err(|error| format!("desk-pilot could not unpack into {}: {error}", base.display()))?;
    let mut node = Command::new("node");
    node.arg(server);
    if env::var_os("DESK_PILOT_DATA_DIR").is_none() {
        node.env("DESK_PILOT_DATA_DIR", base.join("data"));
    }
    let status = node.status().map_err(|error| format!("desk-pilot could not start Node: {error}"))?;
    Ok(status.code().unwrap_or(1))
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    match args.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        [] => {}
        ["-h" | "--help"] => {
            println!("{HELP}");
            return;
        }
        ["-V" | "--version"] => {
            println!("desk-pilot {VERSION}");
            return;
        }
        _ => {
            eprintln!("desk-pilot takes no arguments besides --help and --version\n\n{HELP}");
            process::exit(2);
        }
    }
    match run() {
        Ok(code) => process::exit(code),
        Err(message) => {
            eprintln!("{message}");
            process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_engine_source_is_bundled() {
        let mut found: Vec<String> = fs::read_dir("engine")
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .filter(|name| name.ends_with(".cs"))
            .collect();
        found.sort();
        let bundled: Vec<&str> = ENGINE.iter().map(|(name, _)| *name).collect();
        assert_eq!(found, bundled);
    }

    #[test]
    fn crate_and_server_agree_on_the_version() {
        let server = String::from_utf8_lossy(SERVER);
        assert!(server.contains(&format!("version: \"{VERSION}\"")));
    }

    #[test]
    fn unpack_writes_the_layout_and_repairs_a_changed_file() {
        let root = env::temp_dir().join(format!("desk-pilot-test-{}", process::id()));
        let server = unpack(&root).unwrap();
        assert_eq!(fs::read(&server).unwrap(), SERVER);
        assert!(root.join("engine").join("Overlay.cs").exists());
        fs::write(&server, "changed").unwrap();
        unpack(&root).unwrap();
        assert_eq!(fs::read(&server).unwrap(), SERVER);
        assert_eq!(fs::read_dir(root.join("dist")).unwrap().count(), 1);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn reads_node_versions() {
        assert_eq!(parse_node_version("v24.16.0\r\n"), Some((24, 16)));
        assert_eq!(parse_node_version("nonsense"), None);
        assert!(parse_node_version("v22.18.0").unwrap() < MIN_NODE);
        assert!(parse_node_version("v22.19.0").unwrap() >= MIN_NODE);
    }
}
