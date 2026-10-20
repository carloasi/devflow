// import { CollectionItem } from "./CollectionItem";

// // Definições de tipos (caso use TypeScript)
// export interface PostmanItem {
//   name: string;
//   item?: PostmanItem[]; // Subpastas ou requisições
//   request?: {
//     method: string;
//     url: any;
//     header?: any[];
//     body?: any;
//   };
// }

// export function carregarColecaoPostman(items: any[]): CollectionItem[] {
//   return items.map((item) => {
//     const isFolder = !!item.item; // Se tem a propriedade 'item', é uma pasta

//     // Se for uma requisição, extraímos a URL amigável do Postman
//     let urlRaw = "";
//     if (item.request?.url) {
//       urlRaw = typeof item.request.url === 'string' 
//         ? item.request.url 
//         : item.request.url.raw || "";
//     }

//     return {
//       id: crypto.randomUUID(), // ID único necessário para a árvore do frontend
//       name: item.name,
//       type: isFolder ? 'folder' : 'request',
//       method: item.request?.method || undefined,
      
//       // Se for pasta, chama recursivamente. Se for requisição, mapeia os detalhes
//       ...(isFolder 
//         ? { item: carregarColecaoPostman(item.item || []) }
//         : {
//             request: {
//               url: urlRaw,
//               headers: item.request?.header?.map((h: any) => ({ key: h.key, value: h.value })) || [],
//               body: item.request?.body?.raw || "",
//               urlexport:item.request?.url?.map((h: any) => ({ raw: h.raw, host: [], path:[] })) || []
//             }
//           }
//       )
//     };
//   });
// }

