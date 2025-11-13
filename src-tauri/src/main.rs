// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use rosc::encoder;
use rosc::{OscMessage, OscPacket, OscType};
use std::net::{Ipv4Addr, UdpSocket};
use std::process::Command;
use std::thread;
use tauri::{AppHandle, Emitter, State};
use std::sync::{Arc, Mutex};
use tokio_tungstenite::{connect_async, tungstenite::protocol::Message};
use futures_util::{SinkExt, StreamExt};
use http::Request;

static mut LISTENER_STARTED: bool = false;

// WebSocket connection state
struct QwenWsState {
    sender: Arc<Mutex<Option<futures_util::stream::SplitSink<tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>, Message>>>>,
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_log::Builder::new().build())
        .manage(QwenWsState {
            sender: Arc::new(Mutex::new(None)),
        })
        .invoke_handler(tauri::generate_handler![
            send_typing,
            send_message,
            show_windows_audio_settings,
            start_vrc_listener,
            qwen_ws_connect,
            qwen_ws_send,
            qwen_ws_close
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[tauri::command]
fn send_typing(address: String, port: String) {
    let sock = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).unwrap();
    let msg_buf = encoder::encode(&OscPacket::Message(OscMessage {
        addr: "/chatbox/typing".to_string(),
        args: vec![OscType::Bool(true)],
    }))
    .unwrap();

    sock.send_to(&msg_buf, address + ":" + &port).unwrap();
}

#[tauri::command]
fn send_message(msg: String, address: String, port: String) {
    let sock = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).unwrap();
    let msg_buf = encoder::encode(&OscPacket::Message(OscMessage {
        addr: "/chatbox/input".to_string(),
        args: vec![OscType::String(msg), OscType::Bool(true)],
    }))
    .unwrap();

    sock.send_to(&msg_buf, address + ":" + &port).unwrap();
}

#[tauri::command]
fn show_windows_audio_settings() {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        Command::new("powershell")
            .arg("Start")
            .arg("ms-settings:sound")
            .creation_flags(0x08000000_u32)
            .spawn()
            .unwrap()
            .wait()
            .unwrap();
    }
    
    #[cfg(not(target_os = "windows"))]
    {
        println!("Audio settings only available on Windows");
    }
}

#[tauri::command]
fn start_vrc_listener(app: AppHandle) {
    unsafe {
        if LISTENER_STARTED {
            return;
        }

        LISTENER_STARTED = true;
    }

    thread::spawn(move || {
        let sock = UdpSocket::bind("127.0.0.1:9001");
        match sock {
            Ok(sock) => {
                println!("Starting OSC listener...");
                let mut buf = [0u8; rosc::decoder::MTU];

                loop {
                    match sock.recv_from(&mut buf) {
                        Ok((size, _)) => {
                            let (_, packet) = rosc::decoder::decode_udp(&buf[..size]).unwrap();

                            match packet {
                                OscPacket::Message(msg) => {
                                    // println!("{:?}", msg);
                                    if msg.addr.as_str() == "/avatar/parameters/MuteSelf" {
                                        if let Some(mute) = msg.args.first().unwrap().clone().bool()
                                        {
                                            app.emit("vrchat-mute", mute).unwrap();
                                        }
                                    }
                                }

                                OscPacket::Bundle(bundle) => {
                                    println!("OSC Bundle: {:?}", bundle);
                                }
                            }
                        }
                        Err(e) => {
                            println!("Error receiving from socket: {}", e);
                            break;
                        }
                    }
                }
            }

            Err(e) => {
                println!("Error binding to 9001: {:?}", e);
            }
        }
    });
}

// Qwen ASR WebSocket proxy commands
#[tauri::command]
async fn qwen_ws_connect(
    app: AppHandle,
    state: State<'_, QwenWsState>,
    api_key: String,
    model: String,
) -> Result<(), String> {
    let url = format!("wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model={}", model);
    
    // Parse URL to get authority/host
    let uri = url.parse::<http::Uri>()
        .map_err(|e| format!("Failed to parse URL: {}", e))?;
    
    let authority = uri.authority()
        .ok_or_else(|| "Missing authority in URL".to_string())?
        .as_str();
    
    let host = authority
        .find('@')
        .map(|idx| authority.split_at(idx + 1).1)
        .unwrap_or(authority)
        .to_string();
    
    // Create request with all required WebSocket handshake headers
    // plus our custom application headers
    let request = Request::builder()
        .method("GET")
        .uri(uri)
        .header("Host", host)
        .header("Connection", "Upgrade")
        .header("Upgrade", "websocket")
        .header("Sec-WebSocket-Version", "13")
        .header("Sec-WebSocket-Key", tokio_tungstenite::tungstenite::handshake::client::generate_key())
        .header("Authorization", format!("Bearer {}", api_key))
        .header("OpenAI-Beta", "realtime=v1")
        .body(())
        .map_err(|e| format!("Failed to build request: {}", e))?;

    // Connect to WebSocket
    let (ws_stream, _) = connect_async(request)
        .await
        .map_err(|e| format!("Failed to connect: {}", e))?;

    let (write, mut read) = ws_stream.split();
    
    // Store the sender for later use
    {
        let mut sender = state.sender.lock().unwrap();
        *sender = Some(write);
    }

    // Spawn task to handle incoming messages
    let app_clone = app.clone();
    tokio::spawn(async move {
        while let Some(msg) = read.next().await {
            match msg {
                Ok(Message::Text(text)) => {
                    // Emit message to frontend
                    let _ = app_clone.emit("qwen-ws-message", text);
                }
                Ok(Message::Close(_)) => {
                    let _ = app_clone.emit("qwen-ws-close", ());
                    break;
                }
                Err(e) => {
                    let _ = app_clone.emit("qwen-ws-error", format!("{}", e));
                    break;
                }
                _ => {}
            }
        }
    });

    Ok(())
}

#[tauri::command]
async fn qwen_ws_send(
    state: State<'_, QwenWsState>,
    message: String,
) -> Result<(), String> {
    let sender_opt = {
        let mut sender_lock = state.sender.lock().unwrap();
        sender_lock.take()
    };
    
    if let Some(mut sender) = sender_opt {
        let result = sender
            .send(Message::Text(message))
            .await
            .map_err(|e| format!("Failed to send message: {}", e));
        
        // Put sender back
        let mut sender_lock = state.sender.lock().unwrap();
        *sender_lock = Some(sender);
        
        result
    } else {
        Err("WebSocket not connected".to_string())
    }
}

#[tauri::command]
async fn qwen_ws_close(state: State<'_, QwenWsState>) -> Result<(), String> {
    let sender_opt = {
        let mut sender_lock = state.sender.lock().unwrap();
        sender_lock.take()
    };
    
    if let Some(mut sender) = sender_opt {
        sender
            .send(Message::Close(None))
            .await
            .map_err(|e| format!("Failed to close connection: {}", e))
    } else {
        Err("WebSocket not connected".to_string())
    }
}
