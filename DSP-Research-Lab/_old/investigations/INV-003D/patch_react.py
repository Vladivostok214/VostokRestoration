import re

with open("investigations/INV-003D/VostokRestoration_temp.jsx", "r", encoding="utf-8") as f:
    content = f.read()

# 1. displayedGlitches useMemo update
old_use_memo = """  const displayedGlitches = useMemo(() => {
    return (glitches || [])
      .map((g, idx) => ({ ...g, originalIdx: idx }))
      .filter(g => {
        const conf = g.confidence !== undefined ? g.confidence : 1.0;
        return conf >= minConfidence;
      });
  }, [glitches, minConfidence]);"""

new_use_memo = """  const displayedGlitches = useMemo(() => {
    if (!glitches) return [];
    
    // Support legacy array format or new segregated object format
    let transients = [];
    let stationaries = [];
    
    if (Array.isArray(glitches)) {
        transients = glitches;
    } else {
        transients = glitches.transients || [];
        stationaries = glitches.stationaries || [];
    }
    
    const allEvents = [...transients, ...stationaries];
    
    return allEvents
      .map((g, idx) => ({ ...g, originalIdx: idx }))
      .filter(g => {
        const conf = g.confidence !== undefined ? g.confidence : 1.0;
        return conf >= minConfidence;
      });
  }, [glitches, minConfidence]);"""

content = content.replace(old_use_memo, new_use_memo)

# 2. updatedGlitches combinations
content = re.sub(
    r"const untouchedGlitches = \(glitches \|\| \[\]\)\.filter\(g => g\.time_secs < timeStart \|\| g\.time_secs > timeEnd\);",
    r"const untouchedGlitches = ((Array.isArray(glitches) ? glitches : (glitches?.transients || []).concat(glitches?.stationaries || [])) || []).filter(g => g.time_secs < timeStart || g.time_secs > timeEnd);",
    content
)

# 3. resGlitches in handleAnalyze and handleThresholdChange is a DetectionResult.
# Wait, handleAnalyze has: let updatedGlitches = resGlitches;
# If viewStart > 0, updatedGlitches = [...untouchedGlitches, ...resGlitches.transients, ...resGlitches.stationaries]
old_handle_analyze_comb = """      let updatedGlitches = resGlitches;
      if (viewStart > 0.0 || viewEnd < 1.0) {
        const untouchedGlitches = ((Array.isArray(glitches) ? glitches : (glitches?.transients || []).concat(glitches?.stationaries || [])) || []).filter(g => g.time_secs < timeStart || g.time_secs > timeEnd);
        updatedGlitches = [...untouchedGlitches, ...resGlitches].sort((a, b) => a.time_secs - b.time_secs);
      }"""

new_handle_analyze_comb = """      let updatedGlitches = resGlitches;
      if (viewStart > 0.0 || viewEnd < 1.0) {
        const flatRes = Array.isArray(resGlitches) ? resGlitches : [...(resGlitches.transients || []), ...(resGlitches.stationaries || [])];
        const untouchedGlitches = ((Array.isArray(glitches) ? glitches : (glitches?.transients || []).concat(glitches?.stationaries || [])) || []).filter(g => g.time_secs < timeStart || g.time_secs > timeEnd);
        updatedGlitches = [...untouchedGlitches, ...flatRes].sort((a, b) => a.time_secs - b.time_secs);
      } else {
        updatedGlitches = Array.isArray(resGlitches) ? resGlitches : [...(resGlitches.transients || []), ...(resGlitches.stationaries || [])];
      }"""

content = content.replace(old_handle_analyze_comb, new_handle_analyze_comb)

# 4. handleHealOne updatedGlitches
content = re.sub(
    r"const updatedGlitches = glitches\.map\(g =>\n\s*g\.sample_index === glitch\.sample_index \? \{ \.\.\.g, repaired: true \} : g\n\s*\);",
    r"const updatedGlitches = (Array.isArray(glitches) ? glitches : [...(glitches?.transients || []), ...(glitches?.stationaries || [])]).map(g => g.sample_index === glitch.sample_index ? { ...g, repaired: true } : g);",
    content
)

# 5. handleHealAll updatedGlitches
content = re.sub(
    r"const updatedGlitches = glitches\.map\(g =>\n\s*pendingIndices\.has\(g\.sample_index\) \? \{ \.\.\.g, repaired: true \} : g\n\s*\);",
    r"const updatedGlitches = (Array.isArray(glitches) ? glitches : [...(glitches?.transients || []), ...(glitches?.stationaries || [])]).map(g => pendingIndices.has(g.sample_index) ? { ...g, repaired: true } : g);",
    content
)

# 6. report glitches length
content = content.replace(
    r"report += `  Total Glitches Detectados (Crudos): ${glitches.length}\n`;",
    r"report += `  Total Glitches Detectados (Crudos): ${(Array.isArray(glitches) ? glitches : [...(glitches?.transients || []), ...(glitches?.stationaries || [])]).length}\n`;"
)

with open("investigations/INV-003D/VostokRestoration_temp.jsx", "w", encoding="utf-8") as f:
    f.write(content)

print("VostokRestoration patched.")
