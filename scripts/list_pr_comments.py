import sys
import json
import urllib.request
import os

def fetch_json(url):
    req = urllib.request.Request(
        url, 
        headers={'User-Agent': 'Mozilla/5.0'}
    )
    try:
        with urllib.request.urlopen(req) as response:
            return json.loads(response.read().decode('utf-8'))
    except Exception as e:
        sys.stderr.write(f"Error fetching {url}: {e}\n")
        return []

def main():
    if len(sys.argv) < 2:
        print("Usage: list_pr_comments.py <PR_NUMBER> [--json]")
        sys.exit(1)
        
    pr_number = sys.argv[1]
    repo = os.environ.get('REPO', 'chrislauyc/copilot-ui-llm')
    
    mode = "--json" if len(sys.argv) > 2 and sys.argv[2] == "--json" else "text"
    
    if mode == "--json":
        comments_url = f"https://api.github.com/repos/{repo}/pulls/{pr_number}/comments"
        comments = fetch_json(comments_url)
        output = []
        for c in comments:
            output.append({
                "path": c.get("path"),
                "line": c.get("line"),
                "original_line": c.get("original_line"),
                "side": c.get("side"),
                "author": c.get("user", {}).get("login"),
                "body": c.get("body")
            })
        print(json.dumps(output))
        return

    # Text mode
    # 1. Issue comments
    issue_url = f"https://api.github.com/repos/{repo}/issues/{pr_number}/comments"
    issue_comments = fetch_json(issue_url)
    print(f"=== Issue comments on PR #{pr_number} ===")
    for c in issue_comments:
        author = c.get("user", {}).get("login")
        created_at = c.get("created_at")
        body = c.get("body")
        print(f"[{author}] {created_at}\n{body}\n---")
    print()

    # 2. Review comments
    pull_comments_url = f"https://api.github.com/repos/{repo}/pulls/{pr_number}/comments"
    pull_comments = fetch_json(pull_comments_url)
    print(f"=== Review comments (inline code comments) on PR #{pr_number} ===")
    for c in pull_comments:
        author = c.get("user", {}).get("login")
        path = c.get("path")
        line = c.get("line") if c.get("line") is not None else c.get("original_line")
        body = c.get("body")
        print(f"[{author}] {path}:{line}\n{body}\n---")
    print()

    # 3. Review summaries
    reviews_url = f"https://api.github.com/repos/{repo}/pulls/{pr_number}/reviews"
    reviews = fetch_json(reviews_url)
    print(f"=== Review summaries on PR #{pr_number} ===")
    for r in reviews:
        body = r.get("body", "")
        if body and body.strip():
            author = r.get("user", {}).get("login")
            state = r.get("state")
            print(f"[{author}] state={state}\n{body}\n---")

if __name__ == "__main__":
    main()
