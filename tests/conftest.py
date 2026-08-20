"""Keep the test session hermetic: a local .env may point DATABASE_URL at a
real Postgres (Render), which the e2e suite's TestClient lifespan would try
to connect to — failing the whole run with socket.gaierror.

In-process empty string wins over .env because load_dotenv() uses
override=False and skips keys already present in os.environ. (A PowerShell
`$env:DATABASE_URL = ""` does NOT work on Windows: empty env vars are dropped
when spawning the child process, so the key is absent and dotenv re-applies
the .env value.)
"""
import os

os.environ["DATABASE_URL"] = ""