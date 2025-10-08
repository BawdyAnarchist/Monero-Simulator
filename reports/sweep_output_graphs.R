# Libraries
library(ggplot2)
library(scales)

# ---------- Setup ----------
fp            <- "~/data/001_results_summary.csv"
outputs       <- c("orphanRate", "reorgMax", "reorgP99", "reorg_10_BpW", "selfishShare", "gamma", "diffDiverge")
#outputs       <- c("gamma")
x_var         <- "selfishHP"
pivots        <- c("kThresh", "retortPolicy")         # (0, 1, or 2+ allowed)
#pivots        <- c("kThresh")
filter_ping   <- 70

# Axis controls
x_axis_type   <- "numeric"   # New variable: use "percent" or "numeric"
y_log         <- FALSE
y_log_floor   <- 1e-2 # Floor values for log scale. All y-values below this will be clamped to this value. Set to NULL to disable.
x_lim         <- NULL #c(70, 300)  # Recommended for your PING data
y_lim         <- NULL
x_axis_breaks_include_endpoints <- TRUE 

# Line styling
show_points   <- FALSE
point_size    <- 1.6
point_stroke  <- 0.7
line_size     <- 0.7
line_alpha    <- 0.5
linetype_values <- c("solid","dashed","dotted","dotdash","longdash","twodash")

# Color controls (use one of these)
color_palette <- "Dark2"     # RColorBrewer qualitative palette
color_values  <- c("#bb0000","#00aa00","#1166ee")

# Overlap jitter: 0 is off. Try small percentages. Log-safe.
y_separate    <- 0.01


# ---------- Data ----------
df <- read.csv(fp, stringsAsFactors = FALSE)

# Basic types
if ("P0_HPP" %in% names(df)) df$P0_HPP <- as.numeric(df$P0_HPP)
if ("kThresh" %in% names(df)) df$kThresh <- as.factor(df$kThresh)
if ("retortPolicy" %in% names(df)) df$retortPolicy <- as.factor(df$retortPolicy)

# Filter by PING if requested
if (!is.null(filter_ping) && "PING" %in% names(df)) {
  df <- df[df$PING %in% filter_ping, , drop = FALSE]
}

# Ensure all requested outputs exist and are numeric
missing_out <- setdiff(outputs, names(df))
if (length(missing_out) > 0) {
  stop(sprintf("Missing output columns: %s", paste(missing_out, collapse = ", ")))
}
df[outputs] <- lapply(df[outputs], function(x) suppressWarnings(as.numeric(x)))

# ---------- Plotting ----------
plot_output <- function(out) {
  if (!x_var %in% names(df)) stop(sprintf("x_var '%s' not in data", x_var))
  if (!out %in% names(df)) stop(sprintf("output '%s' not in data", out))
  
  # Build aggregation groups: x + pivots (if any)
  if (length(pivots) > 0) {
    by_list <- c(list(df[[x_var]]), lapply(pivots, function(p) df[[p]]))
    names(by_list) <- c(x_var, pivots)
  } else {
    by_list <- setNames(list(df[[x_var]]), x_var)
  }
  
  agg <- aggregate(df[[out]], by = by_list, FUN = mean, na.rm = TRUE)
  names(agg)[names(agg) == "x"] <- "mean_y"
  
  # --- START: New Y-Value Flooring Logic ---
  # If a log scale is requested and a floor is set, clamp the data.
  if (isTRUE(y_log) && is.numeric(y_log_floor)) {
    # Ensure the floor is a positive number, otherwise log scale is impossible.
    if (y_log_floor <= 0) {
      stop("`y_log_floor` must be a positive number to be used with a log scale.")
    }
    # Replace any value in mean_y smaller than the floor with the floor value.
    agg$mean_y[agg$mean_y < y_log_floor] <- y_log_floor
  }
  # --- END: New Y-Value Flooring Logic ---
  
  if (!nrow(agg)) {
    message(sprintf("No data after filtering for output '%s'. Skipping.", out))
    return(invisible(NULL))
  }
  
  # Small multiplicative separation to reduce exact overlaps (log-safe)
  if (y_separate > 0 && length(pivots) > 0) {
    g  <- interaction(agg[, pivots, drop = FALSE], drop = TRUE)
    gi <- as.integer(g)
    gi <- gi - mean(gi)
    agg$mean_y_adj <- agg$mean_y * (1 + y_separate * gi)
  } else {
    agg$mean_y_adj <- agg$mean_y
  }
  
  # Aesthetics
  col_aes <- if (length(pivots) >= 1) pivots[1] else NULL
  lt_aes  <- if (length(pivots) >= 2) pivots[2] else if (length(pivots) == 1) pivots[1] else NULL
  grp_str <- if (length(pivots) > 0) paste0("interaction(", paste(pivots, collapse = ", "), ")") else "1"
  
  # Base plot
  p <- ggplot(
    agg,
    aes_string(
      x = x_var,
      y = "mean_y_adj",
      color = col_aes,
      linetype = lt_aes,
      group = grp_str
    )
  ) +
    geom_line(size = line_size, alpha = line_alpha, lineend = "round")
  
  # Optional points
  if (isTRUE(show_points)) {
    p <- p + geom_point(size = point_size, stroke = point_stroke, alpha = line_alpha, shape = 1)
  }
  
  # --- START: New X-Axis Breaks Logic ---
  custom_breaks <- waiver() # ggplot's default
  if (isTRUE(x_axis_breaks_include_endpoints)) {
    # Determine the range to calculate breaks over (respecting x_lim)
    break_range <- if (!is.null(x_lim)) x_lim else range(agg[[x_var]], na.rm = TRUE)
    
    # Get the actual min/max from the data
    x_endpoints <- range(agg[[x_var]], na.rm = TRUE)
    
    # Combine ggplot's "pretty" breaks with our data endpoints
    default_breaks <- scales::pretty_breaks()(break_range)
    combined <- c(x_endpoints, default_breaks)
    
    # Keep only unique, sorted breaks that fall within our limits
    custom_breaks <- unique(sort(combined))
    if (!is.null(x_lim)) {
      custom_breaks <- custom_breaks[custom_breaks >= x_lim[1] & custom_breaks <= x_lim[2]]
    }
  }
  # --- END: New X-Axis Breaks Logic ---
  
  # X scale formatting and limits
  if (x_axis_type == "percent") {
    p <- p + scale_x_continuous(
      labels = scales::percent_format(accuracy = 1),
      limits = x_lim,
      breaks = custom_breaks # Apply custom breaks
    )
  } else { # Default to numeric
    p <- p + scale_x_continuous(
      limits = x_lim,
      breaks = custom_breaks # Apply custom breaks
    )
  }
  
  # --- START: Final Y-Axis Logic with DYNAMIC Number Formatting ---
  
  # 1. DETERMINE THE REQUIRED PRECISION FOR SMALL NUMBERS
  # Default to 2 decimal places if no floor is set.
  decimal_places <- 2 
  if (isTRUE(y_log) && is.numeric(y_log_floor) && y_log_floor > 0) {
    # Calculate decimal places directly from the y_log_floor value.
    # This makes the formatting respect your clamp.
    floor_str <- format(y_log_floor, scientific = FALSE)
    if (grepl("\\.", floor_str)) {
      # Count the characters after the decimal point.
      decimal_places <- nchar(strsplit(floor_str, "\\.")[[1]][2])
    } else {
      # If the floor is an integer (e.g., 1), use 0 decimal places.
      decimal_places <- 0
    }
  }
  
  # 2. CREATE THE DYNAMIC FORMATTING FUNCTION
  # This function applies the rules you specified.
  dynamic_formatter <- function(x) {
    # Build the format string for sprintf, e.g., "%.3f" if decimal_places is 3
    small_num_format <- paste0("%.", decimal_places, "f")
    
    # Apply formatting conditionally:
    # - If a value is >= 10, format as an integer with commas.
    # - Otherwise, use the decimal format determined by your y_log_floor.
    ifelse(x >= 10, scales::comma(x, accuracy = 1), sprintf(small_num_format, x))
  }
  
  # 3. APPLY THE FORMATTER TO THE SCALES
  use_log <- isTRUE(y_log) && 
    all(is.finite(agg$mean_y_adj)) && 
    min(agg$mean_y_adj, na.rm = TRUE) > 0
  
  if (use_log) {
    # --- START: New Minor Log Breaks Logic ---
    
    # Calculate the range of exponents (powers of 10) covered by the data
    y_range <- range(agg$mean_y_adj[agg$mean_y_adj > 0], na.rm = TRUE)
    min_exp <- floor(log10(y_range[1]))
    max_exp <- ceiling(log10(y_range[2]))
    
    # Generate the proper minor breaks (2*10^n, 3*10^n, etc.)
    minor_breaks_log10 <- unlist(lapply(min_exp:max_exp, function(p) (2:9) * 10^p))
    
    p <- p + 
      scale_y_log10(
        limits = y_lim, 
        labels = dynamic_formatter,
        minor_breaks = minor_breaks_log10
      ) +
      # Add color = "gray" to this line
      annotation_logticks(sides = "l", color = "gray96") 
    
    # --- END: New Minor Log Breaks Logic ---
  } else {
    p <- p + scale_y_continuous(limits = y_lim, labels = dynamic_formatter)
    if (isTRUE(y_log)) {
      warning(sprintf("Could not use log scale for output '%s'; data may contain zeros, negatives, or non-finite values even after flooring.", out))
    }
  }
  # --- END: Final Y-Axis Logic ---
  
  # Color and Linetype scales
  if (!is.null(col_aes)) {
    if (!is.null(color_values)) p <- p + scale_color_manual(values = color_values)
    else p <- p + scale_color_brewer(palette = color_palette)
  }
  if (!is.null(lt_aes)) {
    p <- p + scale_linetype_manual(values = linetype_values)
  }
  
  # Labels/theme
  p <- p +
    labs(
      title = paste(out, "vs", x_var),
      x = x_var,
      y = out,
      color = col_aes,
      linetype = lt_aes
    ) +
    theme_minimal(base_size = 12) +
    theme(
      legend.position = "right",
      plot.background = element_rect(color = "gray", linewidth = 0.5, fill = NA),
      plot.title = element_text(hjust = 0.5)
    )
  
  p
}

# ---------- Produce charts ----------
if (!nrow(df)) {
  message("No data after filtering. Nothing to plot.")
} else {
  for (out in outputs) {
    p <- plot_output(out)
    if (!is.null(p)) print(p)
  }
}
