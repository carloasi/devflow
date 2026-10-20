#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]


fn main() {
    // Chama a função run definida no lib.rs
    app_lib::run(); 
}