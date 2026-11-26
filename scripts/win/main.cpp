#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif

#include <windows.h>
#include <winhttp.h>
#include <shlobj.h>
#include <shlwapi.h>
#include <objbase.h>
#include <shellapi.h>

#include <atomic>
#include <cstdio>
#include <cstring>
#include <cwchar>
#include <string>

#include "webview2/WebView2.h"

#define IDI_APPICON 101
#define IDM_CREATE_SHORTCUT 0x1010
#define IDM_OPEN_BROWSER 0x1020
#define WM_APP_STATUS (WM_APP + 1)
#define WM_APP_SERVER_READY (WM_APP + 2)
#define WM_APP_SERVER_FAILED (WM_APP + 3)

namespace {

constexpr wchar_t kWindowClass[] = L"ApexEngineerDesktopWindow";
constexpr wchar_t kWindowTitle[] = L"ApexEngineer — Real-Time Sim Racing Coach & Telemetry";
constexpr wchar_t kMutexName[] = L"Local\\ApexEngineerDesktopApp_v1";
constexpr wchar_t kServerUrl[] = L"http://127.0.0.1:3000/";

HWND g_hwnd = nullptr;
HANDLE g_jobObject = nullptr;
HMODULE g_wv2Loader = nullptr;

ICoreWebView2Environment* g_wvEnv = nullptr;
ICoreWebView2Controller* g_wvController = nullptr;
ICoreWebView2* g_wvView = nullptr;

std::atomic<bool> g_exiting{false};
std::atomic<bool> g_serverReady{false};
std::atomic<bool> g_webViewReady{false};
std::atomic<bool> g_navigated{false};
std::atomic<bool> g_webViewFailed{false};

std::wstring g_exeDir;
std::wstring g_appDir;
std::wstring g_statusText = L"Starting telemetry engine & pit wall...";
std::wstring g_subStatusText = L"Checking local runtime...";
int g_progressPct = 15;

using PFN_CreateCoreWebView2EnvironmentWithOptions = HRESULT(STDAPICALLTYPE*)(
    PCWSTR browserExecutableFolder,
    PCWSTR userDataFolder,
    ICoreWebView2EnvironmentOptions* environmentOptions,
    ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler* environmentCreatedHandler);

using PFN_DwmSetWindowAttribute = HRESULT(WINAPI*)(HWND, DWORD, LPCVOID, DWORD);
using PFN_SetProcessDpiAwarenessContext = BOOL(WINAPI*)(HANDLE);

std::wstring GetDirName(const std::wstring& path) {
  size_t pos = path.find_last_of(L"\\/");
  if (pos == std::wstring::npos) return L".";
  return path.substr(0, pos);
}

bool FileExists(const std::wstring& path) {
  DWORD attr = GetFileAttributesW(path.c_str());
  return attr != INVALID_FILE_ATTRIBUTES && (attr & FILE_ATTRIBUTE_DIRECTORY) == 0;
}

bool DirExists(const std::wstring& path) {
  DWORD attr = GetFileAttributesW(path.c_str());
  return attr != INVALID_FILE_ATTRIBUTES && (attr & FILE_ATTRIBUTE_DIRECTORY) != 0;
}

std::wstring JoinPath(const std::wstring& a, const std::wstring& b) {
  if (a.empty()) return b;
  if (a.back() == L'\\' || a.back() == L'/') return a + b;
  return a + L"\\" + b;
}

void PostUiStatus(const std::wstring& mainText, const std::wstring& subText, int pct) {
  if (!g_hwnd || g_exiting.load()) return;
  struct StatusPayload {
    std::wstring mainText;
    std::wstring subText;
    int pct;
  };
  auto* payload = new StatusPayload{mainText, subText, pct};
  if (!PostMessageW(g_hwnd, WM_APP_STATUS, 0, reinterpret_cast<LPARAM>(payload))) {
    delete payload;
  }
}

void EnableDarkTitlebar(HWND hwnd) {
  HMODULE dwm = LoadLibraryW(L"dwmapi.dll");
  if (!dwm) return;
  auto fn = reinterpret_cast<PFN_DwmSetWindowAttribute>(
      GetProcAddress(dwm, "DwmSetWindowAttribute"));
  if (fn) {
    BOOL dark = TRUE;
    fn(hwnd, 20 /* DWMWA_USE_IMMERSIVE_DARK_MODE */, &dark, sizeof(dark));
    COLORREF caption = RGB(11, 14, 21);
    fn(hwnd, 35 /* DWMWA_CAPTION_COLOR */, &caption, sizeof(caption));
  }
  FreeLibrary(dwm);
}

void CreateAppShortcutAt(const std::wstring& lnkPath, const std::wstring& targetExe,
                         const std::wstring& workDir, const std::wstring& iconPath) {
  IShellLinkW* psl = nullptr;
  HRESULT hr = CoCreateInstance(CLSID_ShellLink, nullptr, CLSCTX_INPROC_SERVER,
                                IID_IShellLinkW, reinterpret_cast<void**>(&psl));
  if (FAILED(hr) || !psl) return;

  psl->SetPath(targetExe.c_str());
  psl->SetWorkingDirectory(workDir.c_str());
  psl->SetDescription(L"ApexEngineer — Real-Time Sim Racing Coach & Telemetry");
  if (FileExists(iconPath)) {
    psl->SetIconLocation(iconPath.c_str(), 0);
  } else {
    psl->SetIconLocation(targetExe.c_str(), 0);
  }

  IPersistFile* ppf = nullptr;
  hr = psl->QueryInterface(IID_IPersistFile, reinterpret_cast<void**>(&ppf));
  if (SUCCEEDED(hr) && ppf) {
    ppf->Save(lnkPath.c_str(), TRUE);
    ppf->Release();
  }
  psl->Release();
}

void InstallShortcuts(bool includeDesktop) {
  wchar_t exePath[MAX_PATH] = {0};
  GetModuleFileNameW(nullptr, exePath, MAX_PATH);
  std::wstring iconPath = JoinPath(g_appDir, L"apex-engineer.ico");
  if (!FileExists(iconPath)) {
    iconPath = JoinPath(g_exeDir, L"apex-engineer.ico");
  }

  wchar_t programsDir[MAX_PATH] = {0};
  if (SHGetSpecialFolderPathW(nullptr, programsDir, CSIDL_PROGRAMS, TRUE)) {
    CreateAppShortcutAt(JoinPath(programsDir, L"ApexEngineer.lnk"), exePath, g_exeDir, iconPath);
  }

  if (includeDesktop) {
    wchar_t desktopDir[MAX_PATH] = {0};
    if (SHGetSpecialFolderPathW(nullptr, desktopDir, CSIDL_DESKTOPDIRECTORY, TRUE)) {
      CreateAppShortcutAt(JoinPath(desktopDir, L"ApexEngineer.lnk"), exePath, g_exeDir, iconPath);
    }
  }
}

void EnsureStartMenuShortcutOnce() {
  wchar_t programsDir[MAX_PATH] = {0};
  if (SHGetSpecialFolderPathW(nullptr, programsDir, CSIDL_PROGRAMS, FALSE)) {
    std::wstring startLnk = JoinPath(programsDir, L"ApexEngineer.lnk");
    if (!FileExists(startLnk)) {
      InstallShortcuts(false);
    }
  }
}

bool CheckServerHealth() {
  HINTERNET hSession = WinHttpOpen(L"ApexEngineerDesktop/1.0", WINHTTP_ACCESS_TYPE_NO_PROXY,
                                   WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
  if (!hSession) return false;

  WinHttpSetTimeouts(hSession, 250, 250, 250, 400);
  HINTERNET hConnect = WinHttpConnect(hSession, L"127.0.0.1", 3000, 0);
  if (!hConnect) {
    WinHttpCloseHandle(hSession);
    return false;
  }

  HINTERNET hRequest = WinHttpOpenRequest(hConnect, L"GET", L"/api/health", nullptr,
                                          WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, 0);
  bool ok = false;
  if (hRequest) {
    if (WinHttpSendRequest(hRequest, WINHTTP_NO_ADDITIONAL_HEADERS, 0,
                           WINHTTP_NO_REQUEST_DATA, 0, 0, 0) &&
        WinHttpReceiveResponse(hRequest, nullptr)) {
      DWORD statusCode = 0;
      DWORD size = sizeof(statusCode);
      if (WinHttpQueryHeaders(hRequest,
                              WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                              WINHTTP_HEADER_NAME_BY_INDEX, &statusCode, &size,
                              WINHTTP_NO_HEADER_INDEX)) {
        ok = (statusCode == 200);
      }
    }
    WinHttpCloseHandle(hRequest);
  }
  WinHttpCloseHandle(hConnect);
  WinHttpCloseHandle(hSession);
  return ok;
}

std::wstring FindNodeExecutable() {
  std::wstring localNode = JoinPath(g_appDir, L".nodejs\\node.exe");
  if (FileExists(localNode)) return localNode;

  wchar_t found[MAX_PATH] = {0};
  if (SearchPathW(nullptr, L"node.exe", nullptr, MAX_PATH, found, nullptr) > 0 &&
      FileExists(found)) {
    return found;
  }

  const wchar_t* commonPaths[] = {
      L"C:\\Program Files\\nodejs\\node.exe",
      L"C:\\Program Files (x86)\\nodejs\\node.exe",
  };
  for (const wchar_t* p : commonPaths) {
    if (FileExists(p)) return p;
  }
  return L"";
}

bool BootstrapPortableNode() {
  std::wstring script = JoinPath(g_appDir, L"scripts\\bootstrap-node.ps1");
  if (!FileExists(script)) return false;

  std::wstring cmd =
      L"powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"" +
      script + L"\"";

  STARTUPINFOW si{};
  si.cb = sizeof(si);
  si.dwFlags = STARTF_USESHOWWINDOW;
  si.wShowWindow = SW_HIDE;
  PROCESS_INFORMATION pi{};

  std::wstring cmdMutable = cmd;
  if (!CreateProcessW(nullptr, &cmdMutable[0], nullptr, nullptr, FALSE,
                      CREATE_NO_WINDOW, nullptr, g_appDir.c_str(), &si, &pi)) {
    return false;
  }

  WaitForSingleObject(pi.hProcess, 180000);
  DWORD exitCode = 1;
  GetExitCodeProcess(pi.hProcess, &exitCode);
  CloseHandle(pi.hThread);
  CloseHandle(pi.hProcess);
  return exitCode == 0;
}

void CopyFileIfExists(const std::wstring& src, const std::wstring& dst, bool overwrite) {
  if (FileExists(src) && (overwrite || !FileExists(dst))) {
    CopyFileW(src.c_str(), dst.c_str(), overwrite ? FALSE : TRUE);
  }
}

DWORD WINAPI ServerBootstrapThread(LPVOID) {
  if (CheckServerHealth()) {
    g_serverReady.store(true);
    if (g_hwnd) PostMessageW(g_hwnd, WM_APP_SERVER_READY, 0, 0);
    return 0;
  }

  // Sync optional .env / Gemini key file if launching from parent repo folder
  if (g_exeDir != g_appDir) {
    CopyFileIfExists(JoinPath(g_exeDir, L".env"), JoinPath(g_appDir, L".env"), false);
    CopyFileIfExists(JoinPath(g_exeDir, L"00_ADD_API_KEY_HERE.txt"),
                     JoinPath(g_appDir, L"00_ADD_API_KEY_HERE.txt"), true);
  }

  std::wstring envFile = JoinPath(g_appDir, L".env");
  std::wstring envExample = JoinPath(g_appDir, L".env.example");
  CopyFileIfExists(envExample, envFile, false);

  PostUiStatus(L"Locating runtime...", L"Checking local Node.js runtime", 25);
  std::wstring nodeExe = FindNodeExecutable();
  if (nodeExe.empty()) {
    PostUiStatus(L"First-time setup...",
                 L"Downloading portable Node.js runtime (~25 MB, once only)...", 35);
    BootstrapPortableNode();
    nodeExe = FindNodeExecutable();
  }

  if (nodeExe.empty()) {
    if (g_hwnd) {
      PostMessageW(
          g_hwnd, WM_APP_SERVER_FAILED, 0,
          reinterpret_cast<LPARAM>(new std::wstring(
              L"Could not locate or install Node.js runtime. Please install Node.js LTS from nodejs.org.")));
    }
    return 0;
  }

  std::wstring serverCjs = JoinPath(g_appDir, L"dist-server\\server.cjs");
  if (!FileExists(serverCjs)) {
    if (g_hwnd) {
      PostMessageW(
          g_hwnd, WM_APP_SERVER_FAILED, 0,
          reinterpret_cast<LPARAM>(new std::wstring(
              L"Missing dist-server\\server.cjs. Extract the full ApexEngineer ZIP folder before launching.")));
    }
    return 0;
  }

  PostUiStatus(L"Starting telemetry engine...", L"Opening Pit Wall & UDP :5606 bridge", 60);
  SetEnvironmentVariableW(L"NODE_ENV", L"production");

  std::wstring cmd = L"\"" + nodeExe + L"\" \"" + serverCjs + L"\"";
  STARTUPINFOW si{};
  si.cb = sizeof(si);
  si.dwFlags = STARTF_USESHOWWINDOW;
  si.wShowWindow = SW_HIDE;
  PROCESS_INFORMATION pi{};

  if (!CreateProcessW(nodeExe.c_str(), &cmd[0], nullptr, nullptr, FALSE,
                      CREATE_NO_WINDOW | CREATE_BREAKAWAY_FROM_JOB, nullptr,
                      g_appDir.c_str(), &si, &pi)) {
    // Retry without CREATE_BREAKAWAY_FROM_JOB if disallowed by nested job policy
    ZeroMemory(&pi, sizeof(pi));
    if (!CreateProcessW(nodeExe.c_str(), &cmd[0], nullptr, nullptr, FALSE,
                        CREATE_NO_WINDOW, nullptr, g_appDir.c_str(), &si, &pi)) {
      if (g_hwnd) {
        PostMessageW(
            g_hwnd, WM_APP_SERVER_FAILED, 0,
            reinterpret_cast<LPARAM>(new std::wstring(L"Failed to launch server.cjs.")));
      }
      return 0;
    }
  }

  if (g_jobObject) {
    AssignProcessToJobObject(g_jobObject, pi.hProcess);
  }
  CloseHandle(pi.hThread);

  for (int i = 0; i < 200 && !g_exiting.load(); ++i) {
    if (CheckServerHealth()) {
      g_serverReady.store(true);
      PostUiStatus(L"Loading Pit Wall...", L"Telemetry engine online", 95);
      if (g_hwnd) PostMessageW(g_hwnd, WM_APP_SERVER_READY, 0, 0);
      CloseHandle(pi.hProcess);
      return 0;
    }

    DWORD waitRes = WaitForSingleObject(pi.hProcess, 60);
    if (waitRes == WAIT_OBJECT_0) {
      // Server exited early (maybe another instance already bound port 3000)
      if (CheckServerHealth()) {
        g_serverReady.store(true);
        if (g_hwnd) PostMessageW(g_hwnd, WM_APP_SERVER_READY, 0, 0);
        CloseHandle(pi.hProcess);
        return 0;
      }
      break;
    }
  }

  CloseHandle(pi.hProcess);
  if (!g_exiting.load() && g_hwnd) {
    PostMessageW(
        g_hwnd, WM_APP_SERVER_FAILED, 0,
        reinterpret_cast<LPARAM>(new std::wstring(
            L"ApexEngineer server did not respond on port 3000. Check firewall or port 3000 availability.")));
  }
  return 0;
}

void TryNavigateIfReady() {
  if (g_navigated.load()) return;
  if (g_serverReady.load() && g_webViewReady.load() && g_wvView && g_wvController) {
    g_navigated.store(true);
    RECT bounds{};
    GetClientRect(g_hwnd, &bounds);
    g_wvController->put_Bounds(bounds);
    g_wvController->put_IsVisible(TRUE);
    g_wvView->Navigate(kServerUrl);
  }
}

class PermissionHandler final : public ICoreWebView2PermissionRequestedEventHandler {
  ULONG refCount_{1};

 public:
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppv) override {
    if (!ppv) return E_POINTER;
    if (IsEqualIID(riid, IID_IUnknown) ||
        IsEqualIID(riid, IID_ICoreWebView2PermissionRequestedEventHandler)) {
      *ppv = static_cast<ICoreWebView2PermissionRequestedEventHandler*>(this);
      AddRef();
      return S_OK;
    }
    *ppv = nullptr;
    return E_NOINTERFACE;
  }
  ULONG STDMETHODCALLTYPE AddRef() override { return InterlockedIncrement(&refCount_); }
  ULONG STDMETHODCALLTYPE Release() override {
    ULONG rc = InterlockedDecrement(&refCount_);
    if (rc == 0) delete this;
    return rc;
  }
  HRESULT STDMETHODCALLTYPE Invoke(ICoreWebView2*,
                                   ICoreWebView2PermissionRequestedEventArgs* args) override {
    if (!args) return S_OK;
    COREWEBVIEW2_PERMISSION_KIND kind = COREWEBVIEW2_PERMISSION_KIND_UNKNOWN_PERMISSION;
    if (SUCCEEDED(args->get_PermissionKind(&kind))) {
      if (kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE ||
          kind == COREWEBVIEW2_PERMISSION_KIND_AUTOPLAY ||
          kind == COREWEBVIEW2_PERMISSION_KIND_NOTIFICATIONS) {
        args->put_State(COREWEBVIEW2_PERMISSION_STATE_ALLOW);
      }
    }
    return S_OK;
  }
};

class ControllerCompletedHandler final
    : public ICoreWebView2CreateCoreWebView2ControllerCompletedHandler {
  ULONG refCount_{1};

 public:
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppv) override {
    if (!ppv) return E_POINTER;
    if (IsEqualIID(riid, IID_IUnknown) ||
        IsEqualIID(riid, IID_ICoreWebView2CreateCoreWebView2ControllerCompletedHandler)) {
      *ppv = static_cast<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler*>(this);
      AddRef();
      return S_OK;
    }
    *ppv = nullptr;
    return E_NOINTERFACE;
  }
  ULONG STDMETHODCALLTYPE AddRef() override { return InterlockedIncrement(&refCount_); }
  ULONG STDMETHODCALLTYPE Release() override {
    ULONG rc = InterlockedDecrement(&refCount_);
    if (rc == 0) delete this;
    return rc;
  }
  HRESULT STDMETHODCALLTYPE Invoke(HRESULT result,
                                   ICoreWebView2Controller* controller) override {
    if (FAILED(result) || !controller) {
      g_webViewFailed.store(true);
      PostUiStatus(L"Desktop WebView unavailable",
                   L"Opening in standalone app fallback...", 100);
      ShellExecuteW(nullptr, L"open", kServerUrl, nullptr, nullptr, SW_SHOWNORMAL);
      return result;
    }

    g_wvController = controller;
    g_wvController->AddRef();

    ICoreWebView2Controller2* ctrl2 = nullptr;
    if (SUCCEEDED(controller->QueryInterface(IID_ICoreWebView2Controller2,
                                             reinterpret_cast<void**>(&ctrl2))) &&
        ctrl2) {
      COREWEBVIEW2_COLOR darkBg{255, 9, 11, 16};
      ctrl2->put_DefaultBackgroundColor(darkBg);
      ctrl2->Release();
    }

    if (SUCCEEDED(controller->get_CoreWebView2(&g_wvView)) && g_wvView) {
      ICoreWebView2Settings* settings = nullptr;
      if (SUCCEEDED(g_wvView->get_Settings(&settings)) && settings) {
        settings->put_IsStatusBarEnabled(FALSE);
        settings->put_AreDefaultContextMenusEnabled(TRUE);
        settings->put_IsZoomControlEnabled(TRUE);

        ICoreWebView2Settings2* settings2 = nullptr;
        if (SUCCEEDED(settings->QueryInterface(IID_ICoreWebView2Settings2,
                                               reinterpret_cast<void**>(&settings2))) &&
            settings2) {
          LPWSTR currentUa = nullptr;
          if (SUCCEEDED(settings2->get_UserAgent(&currentUa)) && currentUa) {
            std::wstring ua = std::wstring(currentUa) + L" ApexEngineerDesktop/1.0";
            settings2->put_UserAgent(ua.c_str());
            CoTaskMemFree(currentUa);
          }
          settings2->Release();
        }
        settings->Release();
      }

      EventRegistrationToken tok{};
      auto* permHandler = new PermissionHandler();
      g_wvView->add_PermissionRequested(permHandler, &tok);
      permHandler->Release();
    }

    g_webViewReady.store(true);
    TryNavigateIfReady();
    return S_OK;
  }
};

class EnvironmentCompletedHandler final
    : public ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler {
  ULONG refCount_{1};

 public:
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppv) override {
    if (!ppv) return E_POINTER;
    if (IsEqualIID(riid, IID_IUnknown) ||
        IsEqualIID(riid, IID_ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler)) {
      *ppv = static_cast<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler*>(this);
      AddRef();
      return S_OK;
    }
    *ppv = nullptr;
    return E_NOINTERFACE;
  }
  ULONG STDMETHODCALLTYPE AddRef() override { return InterlockedIncrement(&refCount_); }
  ULONG STDMETHODCALLTYPE Release() override {
    ULONG rc = InterlockedDecrement(&refCount_);
    if (rc == 0) delete this;
    return rc;
  }
  HRESULT STDMETHODCALLTYPE Invoke(HRESULT result, ICoreWebView2Environment* env) override {
    if (FAILED(result) || !env) {
      g_webViewFailed.store(true);
      PostUiStatus(L"Microsoft WebView2 Runtime required",
                   L"Opening Edge/Browser window fallback...", 100);
      if (g_serverReady.load()) {
        ShellExecuteW(nullptr, L"open", kServerUrl, nullptr, nullptr, SW_SHOWNORMAL);
      }
      return result;
    }

    g_wvEnv = env;
    g_wvEnv->AddRef();

    auto* ctrlHandler = new ControllerCompletedHandler();
    HRESULT hr = env->CreateCoreWebView2Controller(g_hwnd, ctrlHandler);
    ctrlHandler->Release();
    return hr;
  }
};

bool InitWebView2(HWND hwnd) {
  std::wstring loaderPaths[] = {
      JoinPath(g_exeDir, L"WebView2Loader.dll"),
      JoinPath(g_appDir, L"WebView2Loader.dll"),
      JoinPath(g_appDir, L"scripts\\win\\webview2\\WebView2Loader.dll"),
  };
  for (const auto& p : loaderPaths) {
    if (FileExists(p)) {
      g_wv2Loader = LoadLibraryW(p.c_str());
      if (g_wv2Loader) break;
    }
  }
  if (!g_wv2Loader) {
    g_wv2Loader = LoadLibraryW(L"WebView2Loader.dll");
  }
  if (!g_wv2Loader) return false;

  auto createEnv = reinterpret_cast<PFN_CreateCoreWebView2EnvironmentWithOptions>(
      GetProcAddress(g_wv2Loader, "CreateCoreWebView2EnvironmentWithOptions"));
  if (!createEnv) return false;

  SetEnvironmentVariableW(L"WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
                          L"--autoplay-policy=no-user-gesture-required");

  wchar_t localAppData[MAX_PATH] = {0};
  std::wstring userDataDir;
  if (SHGetSpecialFolderPathW(nullptr, localAppData, CSIDL_LOCAL_APPDATA, TRUE)) {
    userDataDir = JoinPath(localAppData, L"ApexEngineer\\WebView2");
  } else {
    userDataDir = JoinPath(g_appDir, L".webview2");
  }

  auto* envHandler = new EnvironmentCompletedHandler();
  HRESULT hr = createEnv(nullptr, userDataDir.c_str(), nullptr, envHandler);
  envHandler->Release();
  return SUCCEEDED(hr);
}

void PaintSplash(HWND hwnd) {
  PAINTSTRUCT ps{};
  HDC hdc = BeginPaint(hwnd, &ps);
  RECT rc{};
  GetClientRect(hwnd, &rc);

  HBRUSH bgBrush = CreateSolidBrush(RGB(9, 11, 16));
  FillRect(hdc, &rc, bgBrush);
  DeleteObject(bgBrush);

  int cx = (rc.left + rc.right) / 2;
  int cy = (rc.top + rc.bottom) / 2;

  RECT card{cx - 230, cy - 95, cx + 230, cy + 95};
  HBRUSH cardBrush = CreateSolidBrush(RGB(16, 20, 29));
  HPEN cardPen = CreatePen(PS_SOLID, 1, RGB(27, 34, 48));
  HGDIOBJ oldBrush = SelectObject(hdc, cardBrush);
  HGDIOBJ oldPen = SelectObject(hdc, cardPen);
  RoundRect(hdc, card.left, card.top, card.right, card.bottom, 14, 14);
  SelectObject(hdc, oldBrush);
  SelectObject(hdc, oldPen);
  DeleteObject(cardBrush);
  DeleteObject(cardPen);

  HICON icon = static_cast<HICON>(
      LoadImageW(GetModuleHandleW(nullptr), MAKEINTRESOURCEW(IDI_APPICON), IMAGE_ICON,
                 44, 44, LR_DEFAULTCOLOR));
  if (icon) {
    DrawIconEx(hdc, cx - 22, card.top + 20, icon, 44, 44, 0, nullptr, DI_NORMAL);
    DestroyIcon(icon);
  }

  SetBkMode(hdc, TRANSPARENT);
  HFONT titleFont = CreateFontW(24, 0, 0, 0, FW_BOLD, FALSE, FALSE, FALSE,
                                DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                                CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                                DEFAULT_PITCH | FF_SWISS, L"Segoe UI");
  HFONT subFont = CreateFontW(15, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE,
                              DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                              CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                              DEFAULT_PITCH | FF_SWISS, L"Segoe UI");

  HGDIOBJ oldFont = SelectObject(hdc, titleFont);
  SetTextColor(hdc, RGB(241, 245, 249));
  RECT titleRc{card.left + 20, card.top + 74, card.right - 20, card.top + 106};
  DrawTextW(hdc, L"ApexEngineer", -1, &titleRc, DT_CENTER | DT_SINGLELINE);

  SelectObject(hdc, subFont);
  SetTextColor(hdc, RGB(148, 163, 184));
  RECT statusRc{card.left + 20, card.top + 108, card.right - 20, card.top + 132};
  DrawTextW(hdc, g_statusText.c_str(), -1, &statusRc, DT_CENTER | DT_SINGLELINE | DT_END_ELLIPSIS);

  SetTextColor(hdc, RGB(34, 211, 238));
  RECT subRc{card.left + 20, card.top + 130, card.right - 20, card.top + 152};
  DrawTextW(hdc, g_subStatusText.c_str(), -1, &subRc, DT_CENTER | DT_SINGLELINE | DT_END_ELLIPSIS);

  // Progress bar
  RECT barTrack{card.left + 36, card.bottom - 24, card.right - 36, card.bottom - 18};
  HBRUSH trackBrush = CreateSolidBrush(RGB(27, 34, 48));
  FillRect(hdc, &barTrack, trackBrush);
  DeleteObject(trackBrush);

  int pct = g_progressPct < 5 ? 5 : (g_progressPct > 100 ? 100 : g_progressPct);
  RECT barFill{barTrack.left, barTrack.top,
               barTrack.left + ((barTrack.right - barTrack.left) * pct) / 100,
               barTrack.bottom};
  HBRUSH fillBrush = CreateSolidBrush(RGB(34, 211, 238));
  FillRect(hdc, &barFill, fillBrush);
  DeleteObject(fillBrush);

  SelectObject(hdc, oldFont);
  DeleteObject(titleFont);
  DeleteObject(subFont);
  EndPaint(hwnd, &ps);
}

LRESULT CALLBACK WndProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam) {
  switch (msg) {
    case WM_SIZE:
      if (g_wvController) {
        RECT bounds{};
        GetClientRect(hwnd, &bounds);
        g_wvController->put_Bounds(bounds);
      }
      return 0;

    case WM_SYSCOMMAND:
      if ((wParam & 0xFFF0) == IDM_CREATE_SHORTCUT) {
        InstallShortcuts(true);
        MessageBoxW(hwnd, L"Desktop and Start Menu shortcuts created with the ApexEngineer icon.",
                    L"ApexEngineer", MB_OK | MB_ICONINFORMATION);
        return 0;
      }
      if ((wParam & 0xFFF0) == IDM_OPEN_BROWSER) {
        ShellExecuteW(nullptr, L"open", kServerUrl, nullptr, nullptr, SW_SHOWNORMAL);
        return 0;
      }
      break;

    case WM_APP_STATUS: {
      struct StatusPayload {
        std::wstring mainText;
        std::wstring subText;
        int pct;
      };
      auto* p = reinterpret_cast<StatusPayload*>(lParam);
      if (p) {
        g_statusText = p->mainText;
        g_subStatusText = p->subText;
        g_progressPct = p->pct;
        delete p;
        InvalidateRect(hwnd, nullptr, FALSE);
      }
      return 0;
    }

    case WM_APP_SERVER_READY:
      if (g_webViewFailed.load()) {
        ShellExecuteW(nullptr, L"open", kServerUrl, nullptr, nullptr, SW_SHOWNORMAL);
      } else {
        TryNavigateIfReady();
      }
      return 0;

    case WM_APP_SERVER_FAILED: {
      auto* err = reinterpret_cast<std::wstring*>(lParam);
      std::wstring msgText = err ? *err : L"Failed to start ApexEngineer server.";
      delete err;
      g_statusText = L"Startup Error";
      g_subStatusText = msgText;
      InvalidateRect(hwnd, nullptr, FALSE);
      MessageBoxW(hwnd, msgText.c_str(), L"ApexEngineer", MB_OK | MB_ICONERROR);
      return 0;
    }

    case WM_PAINT:
      PaintSplash(hwnd);
      return 0;

    case WM_DESTROY:
      g_exiting.store(true);
      if (g_wvController) {
        g_wvController->Close();
        g_wvController->Release();
        g_wvController = nullptr;
      }
      if (g_wvView) {
        g_wvView->Release();
        g_wvView = nullptr;
      }
      if (g_wvEnv) {
        g_wvEnv->Release();
        g_wvEnv = nullptr;
      }
      PostQuitMessage(0);
      return 0;
  }
  return DefWindowProcW(hwnd, msg, wParam, lParam);
}

}  // namespace

int WINAPI wWinMain(HINSTANCE hInst, HINSTANCE, PWSTR lpCmdLine, int nCmdShow) {
  CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);

  wchar_t exePath[MAX_PATH] = {0};
  GetModuleFileNameW(nullptr, exePath, MAX_PATH);
  g_exeDir = GetDirName(exePath);
  if (FileExists(JoinPath(g_exeDir, L"dist-server\\server.cjs"))) {
    g_appDir = g_exeDir;
  } else if (FileExists(JoinPath(g_exeDir, L"release\\ApexEngineer\\dist-server\\server.cjs"))) {
    g_appDir = JoinPath(g_exeDir, L"release\\ApexEngineer");
  } else {
    g_appDir = g_exeDir;
  }

  if (lpCmdLine && wcsstr(lpCmdLine, L"--install-shortcut") != nullptr) {
    InstallShortcuts(true);
    CoUninitialize();
    return 0;
  }

  // Enable Per-Monitor DPI awareness when available on Windows 10/11
  HMODULE user32 = GetModuleHandleW(L"user32.dll");
  if (user32) {
    auto setDpi = reinterpret_cast<PFN_SetProcessDpiAwarenessContext>(
        GetProcAddress(user32, "SetProcessDpiAwarenessContext"));
    if (setDpi) {
      setDpi(reinterpret_cast<HANDLE>(-4)); // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2
    } else {
      SetProcessDPIAware();
    }
  }

  HANDLE mutex = CreateMutexW(nullptr, TRUE, kMutexName);
  if (mutex && GetLastError() == ERROR_ALREADY_EXISTS) {
    HWND existing = FindWindowW(kWindowClass, nullptr);
    if (existing) {
      ShowWindow(existing, SW_RESTORE);
      SetForegroundWindow(existing);
    }
    CloseHandle(mutex);
    CoUninitialize();
    return 0;
  }

  // Job Object ensures child node.exe shuts down automatically when window closes
  g_jobObject = CreateJobObjectW(nullptr, nullptr);
  if (g_jobObject) {
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION jeli{};
    jeli.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    SetInformationJobObject(g_jobObject, JobObjectExtendedLimitInformation, &jeli, sizeof(jeli));
  }

  HICON iconBig = static_cast<HICON>(
      LoadImageW(hInst, MAKEINTRESOURCEW(IDI_APPICON), IMAGE_ICON, 48, 48, LR_DEFAULTCOLOR));
  HICON iconSmall = static_cast<HICON>(
      LoadImageW(hInst, MAKEINTRESOURCEW(IDI_APPICON), IMAGE_ICON, 16, 16, LR_DEFAULTCOLOR));

  WNDCLASSEXW wc{};
  wc.cbSize = sizeof(wc);
  wc.lpfnWndProc = WndProc;
  wc.hInstance = hInst;
  wc.hIcon = iconBig;
  wc.hIconSm = iconSmall;
  wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
  wc.hbrBackground = CreateSolidBrush(RGB(9, 11, 16));
  wc.lpszClassName = kWindowClass;
  RegisterClassExW(&wc);

  RECT workArea{0, 0, 1480, 920};
  SystemParametersInfoW(SPI_GETWORKAREA, 0, &workArea, 0);
  int maxW = workArea.right - workArea.left;
  int maxH = workArea.bottom - workArea.top;
  int winW = maxW < 1520 ? static_cast<int>(maxW * 0.94) : 1480;
  int winH = maxH < 960 ? static_cast<int>(maxH * 0.94) : 920;
  int posX = workArea.left + (maxW - winW) / 2;
  int posY = workArea.top + (maxH - winH) / 2;

  g_hwnd = CreateWindowExW(0, kWindowClass, kWindowTitle,
                           WS_OVERLAPPEDWINDOW | WS_CLIPCHILDREN,
                           posX, posY, winW, winH,
                           nullptr, nullptr, hInst, nullptr);

  if (!g_hwnd) {
    if (g_jobObject) CloseHandle(g_jobObject);
    if (mutex) CloseHandle(mutex);
    CoUninitialize();
    return 1;
  }

  EnableDarkTitlebar(g_hwnd);
  if (iconBig) SendMessageW(g_hwnd, WM_SETICON, ICON_BIG, reinterpret_cast<LPARAM>(iconBig));
  if (iconSmall) SendMessageW(g_hwnd, WM_SETICON, ICON_SMALL, reinterpret_cast<LPARAM>(iconSmall));

  HMENU sysMenu = GetSystemMenu(g_hwnd, FALSE);
  if (sysMenu) {
    AppendMenuW(sysMenu, MF_SEPARATOR, 0, nullptr);
    AppendMenuW(sysMenu, MF_STRING, IDM_CREATE_SHORTCUT, L"Create Desktop Shortcut");
    AppendMenuW(sysMenu, MF_STRING, IDM_OPEN_BROWSER, L"Open URL in Browser");
  }

  ShowWindow(g_hwnd, nCmdShow);
  UpdateWindow(g_hwnd);

  EnsureStartMenuShortcutOnce();

  if (!InitWebView2(g_hwnd)) {
    g_webViewFailed.store(true);
    PostUiStatus(L"WebView2 Loader missing",
                 L"Will open fallback window once server is ready...", 45);
  }

  HANDLE hThread = CreateThread(nullptr, 0, ServerBootstrapThread, nullptr, 0, nullptr);
  if (hThread) CloseHandle(hThread);

  MSG msg{};
  while (GetMessageW(&msg, nullptr, 0, 0) > 0) {
    TranslateMessage(&msg);
    DispatchMessageW(&msg);
  }

  g_exiting.store(true);
  if (g_wv2Loader) FreeLibrary(g_wv2Loader);
  if (g_jobObject) CloseHandle(g_jobObject);
  if (mutex) CloseHandle(mutex);
  CoUninitialize();
  return static_cast<int>(msg.wParam);
}
