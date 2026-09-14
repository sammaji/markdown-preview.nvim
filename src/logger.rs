use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_LOG_SIZE: u64 = 1024 * 1024;

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Level {
    Debug,
    Info,
    Error,
}

struct Logger {
    file: Mutex<File>,
    level: Level,
}

static LOGGER: OnceLock<Option<Logger>> = OnceLock::new();

pub fn init() {
    LOGGER.get_or_init(|| {
        let path = std::env::var_os("NVIM_MKDP_LOG_FILE")
            .map(PathBuf::from)
            .unwrap_or_else(|| std::env::temp_dir().join("mkdp-nvim.log"));
        let level = match std::env::var("NVIM_MKDP_LOG_LEVEL").as_deref() {
            Ok("debug") => Level::Debug,
            Ok("error") => Level::Error,
            _ => Level::Info,
        };
        if level == Level::Debug {
            let _ = File::create(&path);
        } else if fs::metadata(&path).is_ok_and(|m| m.len() > MAX_LOG_SIZE) {
            let _ = fs::rename(&path, path.with_extension("log.1"));
        }
        // append mode keeps lines intact when several editor instances log
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .ok()?;
        Some(Logger {
            file: Mutex::new(file),
            level,
        })
    });
}

pub fn log(level: Level, category: &str, args: std::fmt::Arguments) {
    let Some(Some(logger)) = LOGGER.get() else {
        return;
    };
    if level < logger.level {
        return;
    }
    let label = match level {
        Level::Debug => "DEBUG",
        Level::Info => "INFO",
        Level::Error => "ERROR",
    };
    let line = format!(
        "{} {} (pid:{}) [{}] - {}\n",
        timestamp(),
        label,
        std::process::id(),
        category,
        args
    );
    if let Ok(mut file) = logger.file.lock() {
        let _ = file.write_all(line.as_bytes());
    }
}

/// UTC `YYYY-MM-DD HH:MM:SS`, without pulling in a date crate.
fn timestamp() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Howard Hinnant's civil_from_days
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02} {:02}:{:02}:{:02}",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

#[macro_export]
macro_rules! debug {
    ($cat:expr, $($arg:tt)*) => {
        $crate::logger::log($crate::logger::Level::Debug, $cat, format_args!($($arg)*))
    };
}

#[macro_export]
macro_rules! info {
    ($cat:expr, $($arg:tt)*) => {
        $crate::logger::log($crate::logger::Level::Info, $cat, format_args!($($arg)*))
    };
}

#[macro_export]
macro_rules! error {
    ($cat:expr, $($arg:tt)*) => {
        $crate::logger::log($crate::logger::Level::Error, $cat, format_args!($($arg)*))
    };
}
