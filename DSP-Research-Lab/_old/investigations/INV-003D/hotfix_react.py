import re

path = r"C:\Users\WLADI\Vostok Plugins\vostok-apps-web\Vostok Restoration V1\src\components\VostokRestoration.jsx"
with open(path, "r", encoding="utf-8") as f:
    content = f.read()

# The bug is in the audit report generator and the glitch list rendering.
# Stationary events use `start_time_secs` instead of `time_secs`, and don't have `amplitude_delta` or `sample_index`.
# They have `average_db` instead.

def safe_replace(pattern, repl, text):
    new_text = re.sub(pattern, repl, text, flags=re.MULTILINE)
    if text != new_text:
        return new_text
    print(f"Warning: pattern not found: {pattern}")
    return text

# 1. Map properties uniformly in the displayedGlitches mapping.
old_map = r"\.map\(\(g, idx\) => \(\{ \.\.\.g, originalIdx: idx \}\)\)"
new_map = r".map((g, idx) => ({ ...g, originalIdx: idx, time_secs: g.time_secs !== undefined ? g.time_secs : g.start_time_secs, sample_index: g.sample_index !== undefined ? g.sample_index : 0, amplitude_delta: g.amplitude_delta !== undefined ? g.amplitude_delta : (g.average_db !== undefined ? g.average_db : 0.0) }))"
content = safe_replace(old_map, new_map, content)

with open(path, "w", encoding="utf-8") as f:
    f.write(content)

print("VostokRestoration.jsx hotfixed.")