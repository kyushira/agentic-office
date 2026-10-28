"""Print the live snapshot (dev aid): python3 -I dev/snapshot.py [root]"""
import importlib.util, json, sys
from pathlib import Path

p = Path(__file__).resolve().parent.parent / "plugin/agent-office/dashboard/collect.py"
spec = importlib.util.spec_from_file_location("collect", p)
collect = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collect)
print(json.dumps(collect.snapshot(sys.argv[1] if len(sys.argv) > 1 else "/opt/data"), indent=1, default=str))
