; electron-builder 的 Windows 安装目录名只接受 ASCII（正则 /^[-_+0-9a-zA-Z .]+$/），
; 中文 productName「知音」会被回退为包名 zhiyin。这里在安装初始化阶段
; 把安装目录固定为英文「ZhiYin」，应用显示名仍是「知音」。
!macro customInit
  ; initMultiUser 在本宏之前已经把 $INSTDIR 设为默认值，这里直接覆盖为「ZhiYin」
  StrCpy $INSTDIR "$LocalAppData\Programs\ZhiYin"
!macroend

!macro customInstall
  ; 记录用户最终确认的安装目录（含目录选择页改过路径的情况）
  WriteRegStr HKCU "Software\${APP_GUID}" "InstallLocation" "$INSTDIR"
!macroend
