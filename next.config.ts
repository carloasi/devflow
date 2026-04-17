/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export', // Essencial para o Tauri
  images: {
    unoptimized: true, // Tauri não suporta o Image Optimization padrão do Next
  },
};

export default nextConfig;