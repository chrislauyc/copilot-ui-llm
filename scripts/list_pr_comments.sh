#!/bin/bash
set -euo pipefail
python3 "$(dirname "$0")/list_pr_comments.py" "$@"
