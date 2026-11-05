from fastapi import FastAPI, BackgroundTasks, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Dict, Any, Optional
import uuid

from master_job_army import run_master_job_army

app = FastAPI(title="Master Job Army API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "https://uptoskills-project.vercel.app"
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

jobs: Dict[str, Dict[str, Any]] = {}


class ScrapeRequest(BaseModel):
    query: str
    search_type: Optional[str] = "all"
    limit: Optional[int] = 5
    headful: Optional[bool] = False


GENERIC_EMAIL_NAMES = {
    "careers", "career", "jobs", "job", "hr", "info", "contact",
    "hello", "support", "admin", "recruitment", "recruiter",
    "talent", "hiring", "office", "mail", "enquiry", "inquiry",
    "apply", "team",
}


def clean(value) -> str:
    v = str(value).strip() if value is not None else ""
    return "Not Disclosed" if v.lower() in ("", "nan", "none") else v


def email_status(email: str) -> str:
    e = email.strip().lower()
    if e == "not disclosed" or "@" not in e:
        return "Not Disclosed"
    if e.split("@")[0] in GENERIC_EMAIL_NAMES:
        return "Unverified (generic email)"
    return "Unverified (HR data matched)"


def search_hr_file(query: str, search_type: str, limit) -> list:
    import pandas as pd
    from master_job_army import HR_EXCEL_FILE

    df = pd.read_excel(HR_EXCEL_FILE)
    column = {"name": "HR Name", "email": "HR Email", "company": "Company"}[search_type]
    q = query.strip().lower()
    max_rows = int(limit or 20)
    results = []

    for _, row in df.iterrows():
        if q not in str(row.get(column, "")).lower():
            continue
        email = clean(row.get("HR Email"))
        phone = clean(row.get("Mobile NO:"))
        contact_parts = [x for x in (email, phone) if x != "Not Disclosed"]
        results.append({
            "SCORE": 0,
            "COMPANY": clean(row.get("Company")),
            "JOB TITLE": clean(row.get("Job Title")),
            "AREA / LOCATION": clean(row.get("Location")),
            "SALARY": "Not Disclosed",
            "HR NAME": clean(row.get("HR Name")),
            "HR EMAIL": email,
            "HR CONTACT": " | ".join(contact_parts) if contact_parts else "Not Disclosed",
            "VERIFICATION": email_status(email),
            "SOURCE": clean(row.get("Source")),
            "JOB URL": clean(row.get("Job URL")),
            "FULL DESCRIPTION": "Not Disclosed",
        })
        if len(results) >= max_rows:
            break

    return results


def run_job(job_id: str, req: ScrapeRequest):
    jobs[job_id]["status"] = "running"
    try:
        stype = req.search_type or "all"
        if stype in ("name", "email", "company"):
            results = search_hr_file(req.query, stype, req.limit)
        else:
            results = run_master_job_army(
                search_query=req.query,
                headful=bool(req.headful),
                limit=req.limit,
            )
        jobs[job_id]["results"] = results
        jobs[job_id]["status"] = "done"
    except Exception as e:
        jobs[job_id]["error"] = str(e)
        jobs[job_id]["status"] = "error"


@app.get("/")
def health():
    return {"status": "ok"}


@app.post("/scrape")
def start_scrape(req: ScrapeRequest, background_tasks: BackgroundTasks):
    if req.search_type not in (None, "all", "name", "email", "company"):
        raise HTTPException(status_code=400, detail="Invalid search_type")
    job_id = str(uuid.uuid4())
    jobs[job_id] = {"status": "queued", "results": [], "error": None}
    background_tasks.add_task(run_job, job_id, req)
    return {"job_id": job_id, "status": "queued"}


@app.get("/scrape/{job_id}")
def get_scrape(job_id: str):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job