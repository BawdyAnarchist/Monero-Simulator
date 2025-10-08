# Libraries
library(ggplot2)

# ---------- Setup ----------
fp            <- "~/reports/selfish_HPP_ping.csv"
outputs       <- c("orphanRate", "reorgMax", "reorgP99", "reorg10_BPW", "selfishShare", "gamma", "diffDiverge", )
x_var         <- "SelfishHP"
pivots        <- c("kThresh", "retortPolicy")         # (0, 1, or 2+ allowed)
filter_ping   <- NULL

# Axis controls
x_axis_type   <- "numeric"   # New variable: use "percent" or "numeric"
y_log         <- TRUE
x_lim         <- NULL #c(70, 300)  # Recommended for your PING data
y_lim         <- NULL
x_axis_breaks_include_endpoints <- TRUE 

# Line styling
show_points   <- FALSE
point_size    <- 1.6
point_stroke  <- 0.7
line_size     <- 0.7
line_alpha    <- 0.65
linetype_values <- c("solid","dashed","dotted","dotdash","longdash","twodash")

# Color controls (use one of these)
color_palette <- "Dark2"     # RColorBrewer qualitative palette
color_values  <- c("#bb0000","#00aa00","#1166ee")

# Overlap jitter: 0 is off. Try small percentages. Log-safe.
y_separate    <- 0.014


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
  
  # Y scale
  use_log <- isTRUE(y_log) && all(is.finite(agg$mean_y_adj)) && min(agg$mean_y_adj, na.rm = TRUE) > 0
  if (use_log) {
    p <- p + scale_y_log10(limits = y_lim)
  } else {
    p <- p + scale_y_continuous(limits = y_lim)
  }
  
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
    theme(legend.position = "right")
  
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
