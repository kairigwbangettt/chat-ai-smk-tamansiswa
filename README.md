# Chat AI SMK Taman Siswa Cabang Kota Sukabumi

Web chat AI (Express + Gemini) dengan tampilan hijau-kuning.

## Menjalankan di komputer
1. Pasang Node.js LTS (versi 20 atau 22) dari nodejs.org
2. `npm install`
3. Salin `.env.example` menjadi `.env`, lalu isi `GEMINI_API_KEY` (dari aistudio.google.com)
4. `npm start`
5. Buka http://localhost:3000

Daftar model yang tersedia untuk API key: http://localhost:3000/cek-model

## Deploy ke Vercel
Impor repositori ini di vercel.com, lalu isi Environment Variables `GEMINI_API_KEY` dan `MODEL_NAME`.
