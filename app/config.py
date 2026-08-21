import os
from dotenv import load_dotenv

load_dotenv()


class Settings:
    NOTION_TOKEN = os.getenv("NOTION_TOKEN", "")
    NOTION_REQUESTS_DB_ID = os.getenv("NOTION_REQUESTS_DB_ID", "")
    NOTION_BUDGETS_DB_ID = os.getenv("NOTION_BUDGETS_DB_ID", "")
    NOTION_RUNLOG_DB_ID = os.getenv("NOTION_RUNLOG_DB_ID", "")

    GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")
    GROQ_MODEL = os.getenv("GROQ_MODEL", "openai/gpt-oss-20b")

    # Durable state (Render free Postgres). Unset -> in-memory fallback (dev/test only).
    DATABASE_URL = os.getenv("DATABASE_URL", "")

    # Email delivery via Resend HTTPS API (smtplib ports are blocked on Render free tier).
    RESEND_API_KEY = os.getenv("RESEND_API_KEY", "")
    FROM_EMAIL = os.getenv("FROM_EMAIL", "sanction@example.edu")
    ACCOUNTS_EMAIL = os.getenv("ACCOUNTS_EMAIL", "accounts@example.edu")

    # Shared-secret auth for the public trigger endpoint.
    WEBHOOK_SECRET = os.getenv("WEBHOOK_SECRET", "")

    AUTO_APPROVE_CAP_FRACTION = float(os.getenv("AUTO_APPROVE_CAP_FRACTION", "0.15"))
    DUPLICATE_WINDOW_DAYS = int(os.getenv("DUPLICATE_WINDOW_DAYS", "7"))
    MAX_AUTO_APPROVE_AMOUNT = float(os.getenv("MAX_AUTO_APPROVE_AMOUNT", "50000"))


settings = Settings()
