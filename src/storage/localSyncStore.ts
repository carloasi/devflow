import { storeGet, storeSet } from "@/lib/tauriStore";

export async function saveWorkspaceCollections(
  workspace:string,
  data:any[]
){

  if(!workspace) return;

  await storeSet(
    `gh_local_collections_${workspace}`,
    data
  );

}

export async function saveWorkspaceEnvironments(
  workspace:string,
  data:any[]
){

  if(!workspace) return;

  await storeSet(
    `gh_local_environments_${workspace}`,
    data
  );

}


export async function loadWorkspaceLocalData(
  workspace:string
){

  if(!workspace){

    return {
      collections:[],
      environments:[]
    };

  }

  const collections =
    await storeGet<any[]>(
      `gh_local_collections_${workspace}`
    )
    ||
    [];


  const environments =
    await storeGet<any[]>(
      `gh_local_environments_${workspace}`
    )
    ||
    [];


  return {
    collections,
    environments
  };

}