extern crate webview2_com_sys;
pub use webview2_com_sys::Microsoft;

#[macro_use]
extern crate webview2_com_macros;

mod callback;
mod options;
mod pwstr;

use std::{fmt, sync::mpsc};

use windows::{
    core::HRESULT,
    Win32::{
        Foundation::{CloseHandle, HANDLE},
        System::{
            Com::{
                CoWaitForMultipleHandles, COWAIT_DISPATCH_CALLS, COWAIT_DISPATCH_WINDOW_MESSAGES,
            },
            Threading::{CancelWaitableTimer, CreateWaitableTimerW, SetWaitableTimer},
        },
    },
};

pub use callback::*;
pub use options::*;
pub use pwstr::*;

#[derive(Debug)]
pub enum Error {
    WindowsError(windows::core::Error),
    CallbackError(String),
    TaskCanceled,
    SendError,
}

impl std::error::Error for Error {}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write!(f, "{self:?}")
    }
}

impl From<windows::core::Error> for Error {
    fn from(err: windows::core::Error) -> Self {
        Self::WindowsError(err)
    }
}

impl From<HRESULT> for Error {
    fn from(err: HRESULT) -> Self {
        Self::WindowsError(windows::core::Error::from(err))
    }
}

pub type Result<T> = std::result::Result<T, Error>;

/// Wait for a WebView2 async completion while keeping the calling STA
/// re-entrant. WebView2 delivers controller callbacks through COM, so a
/// nested `GetMessage` loop can deadlock when a second controller is created.
pub fn wait_with_pump<T>(rx: mpsc::Receiver<T>) -> Result<T> {
    struct WaitTimer(HANDLE);

    impl Drop for WaitTimer {
        fn drop(&mut self) {
            unsafe {
                let _ = CancelWaitableTimer(self.0);
                let _ = CloseHandle(self.0);
            }
        }
    }

    // The channel has no waitable HANDLE. A short periodic kernel timer wakes
    // the COM modal loop so the receiver can be checked without moving its
    // apartment-bound value to another thread.
    let timer = WaitTimer(unsafe { CreateWaitableTimerW(None, false, None)? });
    let first_due_time = -100_000_i64; // 10 ms, relative time in 100 ns units.
    unsafe {
        SetWaitableTimer(timer.0, &first_due_time, 10, None, None, false)?;
    }

    loop {
        match rx.try_recv() {
            Ok(value) => return Ok(value),
            Err(mpsc::TryRecvError::Disconnected) => return Err(Error::TaskCanceled),
            Err(mpsc::TryRecvError::Empty) => {}
        }

        unsafe {
            CoWaitForMultipleHandles(
                (COWAIT_DISPATCH_CALLS.0 | COWAIT_DISPATCH_WINDOW_MESSAGES.0) as u32,
                u32::MAX,
                &[timer.0],
            )?;
        }
    }
}
