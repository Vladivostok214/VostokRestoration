/// Calcula los coeficientes LPC de orden P para un bloque de muestras in-place utilizando el stack.
/// Retorna `Some(stable_order)` con el orden máximo estable alcanzado (entre 1 y order), o `None` en silencio/error.
pub fn lpc_levinson_durbin_in_place(
    samples: &[f32],
    order: usize,
    out_coefs: &mut [f32],
) -> Option<usize> {
    let n = samples.len();
    if n <= order || order > 128 || out_coefs.len() < order {
        return None;
    }

    // Arrays fijos en el stack (0 heap allocation, soporte hasta orden 128)
    let mut r = [0.0f32; 129];
    let mut a = [0.0f32; 129];
    let mut a_next = [0.0f32; 129];

    // 1. Calcular coeficientes de autocorrelación R[0..=order]
    for l in 0..=order {
        let mut sum = 0.0f64;
        for i in 0..(n - l) {
            sum += (samples[i] as f64) * (samples[i + l] as f64);
        }
        r[l] = sum as f32;
    }

    if r[0] < 1e-9 {
        return None; // Bloque en silencio absoluto
    }

    // 2. Recursión algebraico-iterativa de Levinson-Durbin
    let mut e = r[0];
    a[0] = 1.0;
    let mut stable_order = 0;

    for i in 1..=order {
        let mut sum = 0.0f64;
        for j in 1..i {
            sum += (a[j] as f64) * (r[i - j] as f64);
        }
        
        let ki = (r[i] - sum as f32) / e.max(1e-9);
        
        // Comprobación de estabilidad del filtro predictor
        if ki.abs() >= 1.0 {
            break; // Retornamos el último orden estable
        }

        a[i] = ki;
        a_next[0..=i].copy_from_slice(&a[0..=i]);
        for j in 1..i {
            a_next[j] = a[j] - ki * a[i - j];
        }
        a[0..=i].copy_from_slice(&a_next[0..=i]);
        e *= 1.0 - ki * ki;
        stable_order = i;
        
        if e < 1e-9 {
            break;
        }
    }

    if stable_order == 0 {
        None
    } else {
        out_coefs[0..stable_order].copy_from_slice(&a[1..=stable_order]);
        Some(stable_order)
    }
}

/// Resuelve un sistema lineal de ecuaciones M * X = B usando la eliminación de Gauss con pivoteo parcial.
pub fn solve_linear_system(matrix: &mut [Vec<f32>], rhs: &mut [f32]) -> Option<Vec<f32>> {
    let n = matrix.len();
    for i in 0..n {
        // Encontrar el pivote máximo en la columna i
        let mut max_row = i;
        let mut max_val = matrix[i][i].abs();
        for r in (i + 1)..n {
            let val = matrix[r][i].abs();
            if val > max_val {
                max_val = val;
                max_row = r;
            }
        }
        if max_val < 1e-9 {
            return None; // Matriz singular o mal condicionada
        }
        // Intercambiar filas si es necesario
        if max_row != i {
            matrix.swap(i, max_row);
            rhs.swap(i, max_row);
        }
        // Eliminación hacia adelante
        for r in (i + 1)..n {
            let factor = matrix[r][i] / matrix[i][i];
            for c in i..n {
                matrix[r][c] -= factor * matrix[i][c];
            }
            rhs[r] -= factor * rhs[i];
        }
    }
    // Sustitución hacia atrás
    let mut x = vec![0.0f32; n];
    for i in (0..n).rev() {
        let mut sum = 0.0f32;
        for j in (i + 1)..n {
            sum += matrix[i][j] * x[j];
        }
        x[i] = (rhs[i] - sum) / matrix[i][i];
    }
    Some(x)
}
