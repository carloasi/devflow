import React, { useState, useEffect, useRef } from 'react';

interface EditableTitleProps {
  value: string;
  onSave: (newName: string) => void;
}

export const EditableTitle: React.FC<EditableTitleProps> = ({ value, onSave }) => {
  const [isEditing, setIsEditing] = useState(false);
  const [title, setTitle] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);
  const savingRef = useRef(false); // evita o blur disparar save duas vezes após Enter

  // Sincroniza o estado interno quando a aba ativa muda externamente,
  // mas só se o usuário não estiver editando agora (evita sobrescrever o que ele está digitando)
  useEffect(() => {
    if (!isEditing) {
      setTitle(value);
    }
  }, [value, isEditing]);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const handleSave = () => {
    if (savingRef.current) return;
    savingRef.current = true;

    setIsEditing(false);
    const trimmed = title.trim();

    if (trimmed && trimmed !== value) {
      setTitle(trimmed); // atualização otimista: já reflete na tela na hora
      onSave(trimmed);
    } else {
      setTitle(value); // texto vazio ou igual ao original → restaura
    }

    // libera para o próximo ciclo de edição
    setTimeout(() => { savingRef.current = false; }, 0);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      inputRef.current?.blur(); // dispara handleSave via onBlur, evita duplo save
    } else if (e.key === 'Escape') {
      savingRef.current = true;
      setTitle(value);
      setIsEditing(false);
      setTimeout(() => { savingRef.current = false; }, 0);
    }
  };

  if (isEditing) {
    return (
      <input
        ref={inputRef}
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={handleSave}
        onKeyDown={handleKeyDown}
        className="text-[13px] font-semibold text-pm-text bg-pm-hover border border-pm-border rounded px-1.5 py-0.5 outline-none focus:ring-1 focus:ring-blue-500 max-w-[280px]"
      />
    );
  }

  return (
    <span
      onClick={() => setIsEditing(true)}
      title="Click to edit"
      className="text-[13px] font-semibold text-pm-text-secondary truncate max-w-[280px] cursor-pointer hover:text-pm-text hover:bg-pm-hover/50 px-1.5 py-0.5 rounded transition-colors"
    >
      {title || 'Untitled'}
    </span>
  );
};

// import React, { useState, useEffect, useRef } from 'react';

// interface EditableTitleProps {
//   value: string;
//   onSave: (newName: string) => void;
// }

// export const EditableTitle: React.FC<EditableTitleProps> = ({ value, onSave }) => {
//   const [isEditing, setIsEditing] = useState(false);
//   const [title, setTitle] = useState(value);
//   const inputRef = useRef<HTMLInputElement>(null);

//   // Sincroniza o estado interno caso a aba ativa mude externamente
//   useEffect(() => {
//     setTitle(value);
//   }, [value]);

//   // Coloca o foco e seleciona o texto ao entrar no modo de edição
//   useEffect(() => {
//     if (isEditing && inputRef.current) {
//       inputRef.current.focus();
//       inputRef.current.select();
//       />
//     >
//       {value || 'Sem título'}
//     </span>
//   );
// };