import re

with open("C:/Users/WLADI/Vostok Plugins/vostok-apps-web/Vostok Restoration V1/src-tauri/src/dsp.rs", "r", encoding="utf-8") as f:
    content = f.read()

# I need to ensure start_sample and end_sample are defined BEFORE the local_ceilings logic.
# The original code had them.

old_broken = r"""// Sliding Window Dynamic Ceiling \(2 seconds\)
        let window_size_samples = \(sample_rate \* 2\) as usize;
        let mut local_ceilings = Vec::with_capacity\(end_sample - start_sample\);"""

new_fixed = r"""let start_sample = (start_secs * sample_rate as f64) as usize;
        let end_sample = (end_secs * sample_rate as f64) as usize;
        let start_sample = start_sample.min(samples.len());
        let end_sample = end_sample.min(samples.len()).max(start_sample);

        // Sliding Window Dynamic Ceiling (2 seconds)
        let window_size_samples = (sample_rate * 2) as usize;
        let mut local_ceilings = Vec::with_capacity(end_sample - start_sample);"""

content = re.sub(old_broken, new_fixed, content, flags=re.MULTILINE)

old_residual = r"let spline_residual_factor = \(delta_peak / dynamic_ceiling\)\.min\(1\.0\);"
new_residual = r"let spline_residual_factor = (delta_peak / local_ceilings[start_idx - start_sample]).min(1.0);"
content = content.replace(old_residual, new_residual)

with open("C:/Users/WLADI/Vostok Plugins/vostok-apps-web/Vostok Restoration V1/src-tauri/src/dsp.rs", "w", encoding="utf-8") as f:
    f.write(content)
