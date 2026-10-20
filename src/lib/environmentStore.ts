import { invoke } from '@tauri-apps/api/core'


export async function saveEnvironments(
  environments:any[]
) {

  await invoke(
    'save_environments',
    {
      environments
    }
  )

}


export async function loadEnvironments(){

  return await invoke(
    'load_environments'
  ) as any

}