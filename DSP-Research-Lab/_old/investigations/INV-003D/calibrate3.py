with open("C:/Users/WLADI/Vostok Plugins/vostok-apps-web/Vostok Restoration V1/src-tauri/src/dsp.rs", "r", encoding="utf-8") as f:
    content = f.read()

content = content.replace("let spline_residual_factor = (delta_peak / dynamic_ceiling).min(1.0);", "let spline_residual_factor = (delta_peak / local_ceilings[start_idx - start_sample]).min(1.0);")

with open("C:/Users/WLADI/Vostok Plugins/vostok-apps-web/Vostok Restoration V1/src-tauri/src/dsp.rs", "w", encoding="utf-8") as f:
    f.write(content)
