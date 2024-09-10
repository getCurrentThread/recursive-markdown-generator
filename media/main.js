(function () {
  const vscode = acquireVsCodeApi();

  // 초기 상태 설정
  let currentState = {
    content: "Loading...",
  };

  // 이전 상태 복원 (있는 경우)
  const previousState = vscode.getState();
  if (previousState) {
    currentState = previousState;
    updateContent(currentState.content);
  }

  // 메시지 리스너 설정
  window.addEventListener("message", (event) => {
    const message = event.data;
    switch (message.type) {
      case "update":
        currentState.content = message.content;
        updateContent(message.content);
        // 상태 저장
        vscode.setState(currentState);
        break;
    }
  });

  // 콘텐츠 업데이트 함수
  function updateContent(content) {
    const contentElement = document.getElementById("content");
    contentElement.innerHTML = content;
  }

  // 초기 콘텐츠 업데이트
  updateContent(currentState.content);
})();
