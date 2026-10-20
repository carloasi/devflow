// Os dois só são usados pelo caminho do Windows (ler o registro e embutir a
// foto como data URL). Fora dele a função devolve None sem tocar em nada, e
// sem estes cfg os imports ficariam sem uso — aviso que só apareceria ao
// compilar em macOS ou Linux, que nunca tinha acontecido.
#[cfg(target_os = "windows")]
use base64::{engine::general_purpose, Engine as _};
#[cfg(target_os = "windows")]
use std::process::Command;

#[cfg(target_os = "windows")]
fn get_current_user_sid() -> Option<String> {
    let output = Command::new("whoami")
        .args(["/user", "/fo", "csv", "/nh"])
        .output()
        .ok()?;

    if !output.status.success() {
        eprintln!("❌ [UserPhoto] whoami falhou: status {:?}", output.status);
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let line = stdout.trim();
    eprintln!("🔍 [UserPhoto] whoami raw output: {}", line);

    let sid = line.rsplit('"').nth(1).map(|s| s.trim().to_string())?;
    eprintln!("🔍 [UserPhoto] SID extraído: {}", sid);

    if sid.starts_with("S-1-") {
        Some(sid)
    } else {
        eprintln!("❌ [UserPhoto] SID não bate com padrão esperado: {}", sid);
        None
    }
}

#[cfg(target_os = "windows")]
fn find_picture_path_registry(sid: &str) -> Option<String> {
    use winreg::enums::*;
    use winreg::RegKey;

    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let key_path = format!(
        "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\AccountPicture\\Users\\{}",
        sid
    );

    let key = match hklm.open_subkey(&key_path) {
        Ok(k) => k,
        Err(e) => {
            eprintln!("❌ [UserPhoto] Chave de registro não encontrada em {}: {}", key_path, e);
            return None;
        }
    };

    let candidates = [
        "Image1080", "Image448", "Image240", "Image200",
        "Image192", "Image96", "Image48", "Image40", "Image32",
    ];

    for name in candidates {
        match key.get_value::<String, _>(name) {
            Ok(path) => {
                eprintln!("🔍 [UserPhoto] Registro {} = {}", name, path);
                if std::path::Path::new(&path).exists() {
                    eprintln!("✅ [UserPhoto] Arquivo existe: {}", path);
                    return Some(path);
                } else {
                    eprintln!("⚠️ [UserPhoto] Caminho no registro não existe no disco: {}", path);
                }
            }
            Err(_) => continue,
        }
    }

    None
}

#[cfg(target_os = "windows")]
fn find_picture_path_programdata(sid: &str) -> Option<String> {
    // Fallback: %ProgramData%\Microsoft\User Account Pictures\{SID}\
    let program_data = std::env::var("ProgramData").ok()?;
    let dir = std::path::Path::new(&program_data)
        .join("Microsoft")
        .join("User Account Pictures")
        .join(sid);

    eprintln!("🔍 [UserPhoto] Verificando pasta: {}", dir.display());

    if !dir.exists() {
        eprintln!("❌ [UserPhoto] Pasta não existe: {}", dir.display());
        return None;
    }

    // pega qualquer arquivo de imagem dentro da pasta, preferindo o maior nome (geralmente maior resolução)
    let mut entries: Vec<_> = std::fs::read_dir(&dir).ok()?.filter_map(|e| e.ok()).collect();
    entries.sort_by_key(|e| e.file_name());

    for entry in entries.iter().rev() {
        let path = entry.path();
        if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
            let ext = ext.to_lowercase();
            if ext == "jpg" || ext == "jpeg" || ext == "png" || ext == "bmp" {
                eprintln!("✅ [UserPhoto] Encontrado via ProgramData: {}", path.display());
                return Some(path.to_string_lossy().to_string());
            }
        }
    }

    None
}

#[tauri::command]
pub fn get_windows_user_photo() -> Result<Option<String>, String> {
    #[cfg(target_os = "windows")]
    {
        let sid = match get_current_user_sid() {
            Some(s) => s,
            None => {
                eprintln!("❌ [UserPhoto] Não foi possível obter o SID do usuário atual.");
                return Ok(None);
            }
        };

        let path = find_picture_path_registry(&sid)
            .or_else(|| find_picture_path_programdata(&sid));

        let path = match path {
            Some(p) => p,
            None => {
                eprintln!("❌ [UserPhoto] Nenhuma foto encontrada (registro nem ProgramData) para SID {}", sid);
                return Ok(None);
            }
        };

        let bytes = std::fs::read(&path).map_err(|e| {
            eprintln!("❌ [UserPhoto] Falha ao ler arquivo {}: {}", path, e);
            e.to_string()
        })?;

        let mime = match path.to_lowercase() {
            p if p.ends_with(".png") => "image/png",
            p if p.ends_with(".bmp") => "image/bmp",
            _ => "image/jpeg",
        };

        let encoded = general_purpose::STANDARD.encode(&bytes);
        Ok(Some(format!("data:{};base64,{}", mime, encoded)))
    }

    #[cfg(not(target_os = "windows"))]
    {
        Ok(None)
    }
}