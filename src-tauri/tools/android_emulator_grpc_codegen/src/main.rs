use std::io::Write;
use std::path::{Path, PathBuf};

use tempfile::{NamedTempFile, TempDir};

const NOTICE: &str = "// Recorte gerado de android/emulator_controller.proto (AOSP Apache-2.0).\n// Gerador: protoc 27.1 + tonic-build/prost-build 0.13.1. NÃO editar à mão.\n";

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let mut args = std::env::args_os().skip(1);
    let proto = PathBuf::from(args.next().ok_or("missing proto path")?);
    let include = PathBuf::from(args.next().ok_or("missing include root")?);
    let output = PathBuf::from(args.next().ok_or("missing output path")?);
    if args.next().is_some() {
        return Err("expected exactly three arguments".to_string());
    }
    let protoc = std::env::var_os("PROTOC").ok_or("PROTOC must point to protoc 27.1")?;
    let version = std::process::Command::new(&protoc)
        .arg("--version")
        .output()
        .map_err(|error| format!("run protoc: {error}"))?;
    if !version.status.success() || version.stdout != b"libprotoc 27.1\n" {
        return Err("PROTOC must report exactly libprotoc 27.1".to_string());
    }
    let bytes = generate_bytes_with(|temporary| {
        std::env::set_var("OUT_DIR", temporary);
        tonic_build::configure()
            .build_server(false)
            .compile_protos(&[proto.as_path()], &[include.as_path()])
            .map_err(|error| format!("generate bindings: {error}"))
    })?;
    write_output(&output, &bytes)?;
    Ok(())
}

fn generate_bytes_with(
    compile: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<Vec<u8>, String> {
    let temporary: TempDir = tempfile::Builder::new()
        .prefix("verboo-android-emulator-grpc-codegen-")
        .tempdir()
        .map_err(|error| format!("create generator directory: {error}"))?;
    compile(temporary.path())?;
    let generated = temporary.path().join("android.emulation.control.rs");
    let mut bytes = NOTICE.as_bytes().to_vec();
    bytes.extend(
        std::fs::read(&generated).map_err(|error| format!("read generated bindings: {error}"))?,
    );
    Ok(bytes)
}

fn write_output(path: &Path, bytes: &[u8]) -> Result<(), String> {
    write_output_with(path, |file| file.write_all(bytes))
}

fn write_output_with(
    path: &Path,
    write: impl FnOnce(&mut std::fs::File) -> std::io::Result<()>,
) -> Result<(), String> {
    let parent = path.parent().ok_or("output path has no parent")?;
    std::fs::create_dir_all(parent).map_err(|error| format!("create output directory: {error}"))?;
    let mut temporary = NamedTempFile::new_in(parent)
        .map_err(|error| format!("create output temporary file: {error}"))?;
    write(temporary.as_file_mut()).map_err(|error| format!("write generated bindings: {error}"))?;
    temporary
        .persist(path)
        .map(|_| ())
        .map_err(|error| format!("persist generated bindings: {}", error.error))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_output_replaces_an_existing_binding() {
        let directory = tempfile::tempdir().unwrap();
        let output = directory.path().join("binding.rs");
        std::fs::write(&output, b"old binding").unwrap();

        write_output(&output, b"new binding").unwrap();

        assert_eq!(std::fs::read(&output).unwrap(), b"new binding");
    }

    #[test]
    fn failed_staged_write_preserves_the_existing_binding_and_cleans_the_tempfile() {
        let directory = tempfile::tempdir().unwrap();
        let output = directory.path().join("binding.rs");
        std::fs::write(&output, b"old binding").unwrap();

        let error = write_output_with(&output, |file| {
            file.write_all(b"partial binding")?;
            Err(std::io::Error::new(
                std::io::ErrorKind::Other,
                "forced staged write failure",
            ))
        })
        .unwrap_err();

        assert!(error.contains("forced staged write failure"));
        assert_eq!(std::fs::read(&output).unwrap(), b"old binding");
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    fn temporary_working_directory_is_removed_after_a_generator_error() {
        let mut temporary_path = None;

        let result = generate_bytes_with(|temporary| {
            temporary_path = Some(temporary.to_path_buf());
            Err("forced generator error".to_string())
        });

        assert_eq!(result.unwrap_err(), "forced generator error");
        assert!(!temporary_path.unwrap().exists());
    }
}
