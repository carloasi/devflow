use keyring::Entry;

const SERVICE_NAME: &str = "com.DevFlow.dev"; // confirme se é o identifier real do seu tauri.conf.json

fn entry(key: &str) -> Result<Entry, String> {
    Entry::new(SERVICE_NAME, key).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_secret(key: String, value: String) -> Result<(), String> {
    let entry = entry(&key)?;
    entry.set_password(&value).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_secret(key: String) -> Result<Option<String>, String> {
    let entry = entry(&key)?;
    match entry.get_password() {
        Ok(password) => Ok(Some(password)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn delete_secret(key: String) -> Result<(), String> {
    let entry = entry(&key)?;
    match entry.delete_password() {   // 👈 delete_password, não delete_credential
        Ok(_) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}