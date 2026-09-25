# Azure DevOps AI PR Reviewer

บริการ review Pull Request สำหรับ Azure Repos ที่รันภายในเครื่อง ระบบจะตรวจสอบ
PR ทุก 5 นาที วิเคราะห์ commit ใหม่ด้วยโมเดลที่รองรับ OpenAI API, โพสต์คอมเมนต์
แบบ inline และเก็บประวัติการ review ไว้ใน SQLite

## การติดตั้ง

1. คัดลอก `.env.example` เป็น `.env` แล้วกรอกข้อมูล credential ให้ครบ
2. กำหนดสิทธิ์ Azure DevOps PAT เพียง **Code (Read)** และ
   **Pull Request Threads (Read & Write)**
3. เริ่มทั้งสองบริการ:

   ```sh
   docker compose up --build
   ```

4. เปิด <http://localhost:5173> แล้วกรอก `DASHBOARD_AUTH_TOKEN`

Health endpoint ของ API อยู่ที่ <http://localhost:8000/health> ส่วน endpoint ใต้
`/api/*` ต้องส่ง bearer token ทุกครั้ง

ค่า `VITE_API_BASE_URL` จะถูกฝังอยู่ใน frontend bundle หากเปลี่ยนค่าที่
`docker-compose.yml` ต้อง build frontend image ใหม่

## LLM และการจัดการโค้ด

จัดการโมเดล AI ได้ที่หน้า **Models** ของ Dashboard โดยรองรับ endpoint ที่เข้ากันได้กับ
OpenAI API พร้อม API key, model id และอัตราค่าใช้จ่าย ควรตรวจสอบให้แน่ใจว่าองค์กร
อนุมัติผู้ให้บริการโมเดลที่เลือกแล้ว เนื่องจากเงื่อนไขการเก็บข้อมูลและการนำข้อมูลไป train
แตกต่างกันตามผู้ให้บริการและภูมิภาค ตัวอย่างเช่นโมเดลที่โฮสต์โดย DeepSeek อาจประมวลผล
ข้อมูลในจีน

ระบบจะไม่นำ generated files, dependency locks, `dist/`, `vendor/` และ
`node_modules/` ไป review และจะข้าม diff ที่มีขนาดเกิน `MAX_CHANGED_LINES`
สามารถตั้งอัตราราคาต่อหนึ่งล้าน token ของแต่ละโมเดลได้ แต่เวอร์ชันปัจจุบันยังไม่ได้
บังคับใช้เพดานค่าใช้จ่ายรายวัน

## การ deploy ภายใน

ควรรันทั้ง frontend และ backend บนเครื่องภายในหรือ private network เช่น Tailscale
ไม่ควรเปิด backend ออกสู่ public internet ผ่าน port forwarding เพราะ backend เก็บ
Azure DevOps PAT และ LLM key ไว้ ข้อมูล SQLite จะเก็บที่ `backend/data/`
