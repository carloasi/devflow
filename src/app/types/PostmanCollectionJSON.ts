//             ? item.request.url 
//             : (item.request?.url?.raw || ''),
//           headers: Array.isArray(item.request?.header)
//             ? item.request.header.map((h: any) => ({
//                 key: h.key,
//                 value: h.value,
//                 enabled: !h.disabled
//               }))
//             : [],