import { invoke } from "@tauri-apps/api/core";


export async function saveLocalStore(
    key:string,
    value:any
){
    await invoke(
        "save_local_store",
        {
            key,
            value
        }
    );
}



export async function getLocalStore(
    key:string
){
    return await invoke<any>(
        "get_local_store",
        {
            key
        }
    );
}

// Apaga todas as chaves de settings.json que começam com `prefix` — usado
// pra limpar de uma vez histórico armazenado sob várias chaves (uma por
// item), sem precisar saber os ids de antemão.
export async function clearLocalStorePrefix(
    prefix:string
){
    await invoke(
        "clear_local_store_prefix",
        {
            prefix
        }
    );
}