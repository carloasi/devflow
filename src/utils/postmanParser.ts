import { CollectionItem } from '@/app/types/CollectionItem'
import { parsePostmanImport } from '@/components/usePostmanImport'
import { cloneItemWithNewIds } from '@/components/collection-tree/utils/tree.utils'

/*
 * Antes este arquivo tinha seu próprio conversor Postman→interno
 * (mapPostmanItems), mais simples e divergente do usado pelo import de
 * ambientes/GitHub Sync (parsePostmanImport, em usePostmanImport.tsx).
 * Isso causava bugs: Basic Auth e API Key não eram extraídos (só bearer),
 * o type 'noauth' do Postman vazava direto pro seletor de Auth da UI (que
 * só reconhece 'none'), path variables importadas ficavam sem "id" (bug já
 * remendado em ParamsTab.tsx), e corpos form-data/urlencoded/graphql eram
 * descartados.
 *
 * Agora delega inteiramente pro parser mais completo — mesma lógica pro
 * botão "Import Collection" e pro Sync com GitHub.
 */
export function parsePostmanCollection(
  fileContent: string,
  fileName: string,
  currentItems: CollectionItem[]
): CollectionItem[] {
  try {
    const parsedJson = JSON.parse(fileContent);
    const result = parsePostmanImport(parsedJson);

    if (!result.collections || result.collections.length === 0) {
      alert(result.warnings.length ? result.warnings.join('\n') : 'No collection found in this file.');
      return currentItems;
    }

    const cleanFolderName = fileName
      .replace(/\.postman_collection\.json$/i, '')
      .replace(/\.json$/i, '');

    const rootCollectionFolder: CollectionItem = {
      id: crypto.randomUUID(),
      name: cleanFolderName,
      type: 'folder',
      // Ids novos em tudo (pastas, requests e examples): os do Postman se
      // repetiriam se a mesma collection fosse importada de novo, e aí abrir
      // um item abria o outro.
      item: result.collections.map(cloneItemWithNewIds),
    };

    return [...currentItems, rootCollectionFolder];
  } catch (error) {
    console.log("Falha ao parsear o arquivo Postman:", error);
    alert("An error occurred while processing the file. Make sure it is a valid Postman collection.");
    return currentItems;
  }
}


// import { CollectionItem } from '@/app/types/CollectionItem'
// import { url } from 'inspector';

// // Mapeia recursivamente os subitens (pastas e requests) do Postman
// function mapPostmanItems(postmanItems: any[]): CollectionItem[] {
//   if (!postmanItems) return [];

//   return postmanItems.map((item) => {
//     const isFolder = Array.isArray(item.item);

//     // Extração de Scripts
//     const events = item.event || [];
//     const preRequestScript = events.find((e: any) => e.listen === 'prerequest')?.script?.exec?.join('\n') || '';
//     const testScript = events.find((e: any) => e.listen === 'test')?.script?.exec?.join('\n') || '';

//     // --- NOVA LÓGICA DE AUTH ---
//     let authData = undefined;
//     const itemAuth = item.request?.auth || item.auth; // Verifica na request ou na pasta

//     if (itemAuth) {
//       authData = {
//         type: itemAuth.type, // 'bearer', 'basic', etc.
//         // Se for bearer, extrai o token do array de propriedades
//         token: itemAuth.type === 'bearer' 
//           ? itemAuth.bearer?.find((p: any) => p.key === 'token')?.value 
//           : undefined,
//             ? item.request.url 
//             : (item.request?.url?.raw || ''),
//           urlexport: {
//             raw:item.request?.url?.raw || '',
//             host: Array.isArray(item.request?.url?.host) ? item.request.url.host  : [],
//             path: Array.isArray(item.request?.url?.path) ? item.request.url.path  : [],
//             variable:Array.isArray(item.request?.url?.variable)
//             ? item.request?.url?.variable.map((h: any) => ({
//                 key: h.key,
//                 value: h.value || '',
//               }))
//             : [],
//           },
//           headers: Array.isArray(item.request?.header)
//             ? item.request.header.map((h: any) => ({
//                 key: h.key,
//                 value: h.value || '',
//                 enabled: !h.disabled
//               }))
//             : [],