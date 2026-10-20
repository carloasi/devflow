import { invoke } from "@tauri-apps/api/core";


export async function storeGet<T>(
    key:string
):Promise<T | null>{

    const result = await invoke<any>("store_get", {
        key
    });

    return result as T ?? null;
}



export async function storeSet(
    key:string,
    value:any
){

    await invoke(
        "store_set",
        {
            key,
            value
        }
    );

}



export async function storeDelete(
    key:string
){

    await invoke(
        "store_delete",
        {
            key
        }
    );

}