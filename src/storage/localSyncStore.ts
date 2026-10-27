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
// Catálogo de marcadores do workspace (ver lib/markers.ts).
//
// Fica ao lado das collections e não dentro delas: o marcador é do
// workspace, e o mesmo "flaky" tem que valer nas várias collections — se
// cada uma carregasse o próprio catálogo, filtrar por marcador não juntaria
// nada entre elas.
export async function saveWorkspaceMarkers(
  workspace: string,
  markers: unknown[]
) {
  if (!workspace) return;

  await storeSet(
    `gh_local_markers_${workspace}`,
    markers
  );
}

export async function loadWorkspaceMarkers(
  workspace: string
): Promise<unknown[]> {
  if (!workspace) return [];

  return (
    await storeGet<unknown[]>(
      `gh_local_markers_${workspace}`
    )
  ) || [];
}
